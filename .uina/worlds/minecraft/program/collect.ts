export const COLLECT_DEFAULT_COUNT = 1;
export const collectProgram = `async function main(mc, input) {
  const { item: requestedItem, count = ${COLLECT_DEFAULT_COUNT}, radius = 32, digThrough = false, tool } = input;
  let info;
  try {
    info = (await mc.read("item@1", { name: requestedItem })).value;
  } catch (error) {
    if (error.code !== "NOT_FOUND") throw error;
    mc.fail("NOT_FOUND", "unknown item " + requestedItem, "check item@1 for the canonical name");
  }
  if (!info) mc.fail("WRONG_STATE", "static knowledge is not ready");
  const item = info.name;
  const sources = info.sources.filter(source => source.kind === "block");
  if (!sources.length) mc.fail("NOT_FOUND", item + " has no block source in this version's data");

  const inventory = async (selector) => {
    const { value } = await mc.read("inventory@1", selector == null ? {} : { matching: selector });
    if (!value) mc.fail("WRONG_STATE", "inventory is not available");
    return value;
  };
  let bag = await inventory(tool);
  const tools = tool == null ? bag.slots : bag.matchingSlots;
  if (tool != null && !tools.length) mc.fail("MISSING_MATERIAL", "requested tool is not in the inventory");
  const harvestable = sources.filter(source => source.harvest.kind === "any" ||
    (source.harvest.kind === "tools" && tools.some(slot => source.harvest.names.includes(slot.name))));
  if (!harvestable.length) {
    const required = [...new Set(sources.flatMap(source => source.harvest.names ?? []))];
    mc.fail("MISSING_TOOL", "no inventory tool can harvest any source block of " + item,
      "required: " + (required.join(", ") || "unknown"));
  }
  const blockNames = [...new Set(harvestable.map(source => source.block))];
  const budget = Math.min(300000, count * 20000 + 20000);
  const deadline = Date.now() + budget;
  const key = ({ x, y, z }) => [x, y, z].join(",");
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const center = ({ x, y, z }) => ({ x: x + 0.5, y, z: z + 0.5 });
  const countOf = (value) => value.counts[item] ?? 0;
  const initialCount = countOf(bag);
  const tried = new Map();
  const toolsUsed = new Set();
  let frontier = [];
  let acquired = 0;
  let mined = 0;
  let attempted = 0;
  let skipped = 0;
  let lastSkip = "";
  const progress = () => {
    const remaining = Math.max(0, count - acquired);
    return {
      phase: "gathering", acquired, mined, collected: acquired ? { [item]: acquired } : {}, toolsUsed: [...toolsUsed],
      candidates: { attempted, skipped, blocked: tried.size, uncertain: 0 },
      goal: { state: remaining ? "unsatisfied" : "satisfied", total: count, completed: Math.min(count, acquired),
        remaining, blocked: 0, uncertain: 0 },
      reasons: remaining ? { not_listed: remaining } : {},
    };
  };
  const fail = (code, message, hint) => {
    mc.progress(progress());
    mc.fail(code, message + (lastSkip ? " (last skipped cell: " + lastSkip + ")" : ""), hint);
  };
  const skip = (at, kind, error) => {
    tried.set(key(at), { at, kind });
    lastSkip = error.code + ": " + error.message;
    skipped++;
  };
  const refresh = async () => {
    const after = await inventory();
    const gained = countOf(after) > countOf(bag);
    acquired = Math.max(0, countOf(after) - initialCount);
    bag = after;
    if (gained) {
      for (const [id, attempt] of tried) if (attempt.kind === "transient") tried.delete(id);
      frontier = [];
    }
    mc.progress(progress());
  };
  const pickup = async (radius, maxTimeMs) => {
    try {
      await mc.call("pickup@1", { item, radius, maxTimeMs });
    } catch (error) {
      if (!["NOT_FOUND", "TIMEOUT", "UNREACHABLE", "INVENTORY_FULL"].includes(error.code) ||
          error.dispatch === "unknown") throw error;
    }
    await refresh();
  };

  while (acquired < count) {
    if (Date.now() >= deadline)
      fail("TIMEOUT", "collect budget ran out with " + acquired + "/" + count + " " + item, "retry with the remaining count");
    const self = (await mc.read("self@1")).value;
    if (!self) fail("WRONG_STATE", "self state is not available");
    const here = self.place.position;
    if (info.stackSize != null && bag.freeSlots === 0 &&
        !bag.slots.some(slot => slot.slot >= 9 && slot.slot <= 44 && slot.name === item && slot.count < info.stackSize))
      fail("INVENTORY_FULL", "no room for another " + item, "free a main-inventory slot first");
    if (!frontier.length) {
      if (mined > acquired) await pickup(8, 8000);
      if (acquired >= count) break;
      const seen = new Set();
      const exclude = [...tried.values()].slice(-32).map(attempt => attempt.at);
      for (const name of blockNames) {
        const found = (await mc.read("blocks@1", { name, radius, limit: 16, exclude })).value;
        for (const { position } of found?.blocks ?? []) {
          const id = key(position);
          if (tried.has(id) || seen.has(id)) continue;
          seen.add(id);
          frontier.push(position);
        }
      }
      if (!frontier.length) fail("NOT_FOUND", "no " + blockNames.join("/") + " left within " + radius + " blocks",
        "widen radius, or move to where the block occurs");
    }
    frontier.sort((a, b) => distance(a, here) - distance(b, here));
    const [first] = frontier;
    const underfoot = first.x === Math.floor(here.x) && first.z === Math.floor(here.z) && first.y === Math.floor(here.y) - 1;
    const [at] = frontier.splice(frontier.length > 1 && underfoot ? 1 : 0, 1);
    if (attempted >= Math.max(8, count * 4)) fail("UNREACHABLE", "too many source blocks could not be reached or broken");
    attempted++;
    if (distance({ x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5 }, { ...here, y: here.y + 1.62 }) > 3) {
      try {
        await mc.call("goto@1", { at: center(at), tolerance: 1, digThrough,
          maxTimeMs: Math.max(1000, Math.min(15000, deadline - Date.now())) });
      } catch (error) {
        if (error.dispatch === "unknown" ||
            (digThrough && error.dispatch !== "not_sent") ||
            !["NOT_FOUND", "TIMEOUT", "UNREACHABLE"].includes(error.code)) {
          mc.progress(progress());
          throw error;
        }
        skip(at, error.code === "NOT_FOUND" ? "permanent" : "transient", error);
        continue;
      }
    }
    try {
      const result = await mc.call("mine@1", { at, collect: false, ...(tool == null ? {} : { tool }) });
      if (!result.broken) continue;
      mined++;
      if (result.tool != null) toolsUsed.add(result.tool);
    } catch (error) {
      if (error.dispatch !== "not_sent" || error.effects?.length ||
          !["NOT_FOUND", "UNREACHABLE", "TIMEOUT"].includes(error.code)) {
        mc.progress(progress());
        throw error;
      }
      skip(at, error.code === "NOT_FOUND" ? "permanent" : "transient", error);
      continue;
    }
    const before = acquired;
    await mc.waitUntil({ bag: { ref: "inventory@1" } },
      (values) => values.bag != null && countOf(values.bag) > countOf(bag), { timeoutMs: 1500 });
    await refresh();
    if (before === acquired) await pickup(4, 5000);
  }
  return { mined, acquired, collected: { [item]: acquired }, remaining: 0, toolsUsed: [...toolsUsed] };
}
`;
