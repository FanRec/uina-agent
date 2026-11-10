export const buildResumeProgram = `
async function main(mc, input) {
  const request = { cells: input.cells, replace: false };
  const plan = (await mc.read("build.plan@1", request)).value;
  if (!plan) mc.decide("Construction plan is unavailable");
  if (plan.targets.some((target) => target.kind !== "set"))
    mc.decide("Resumable construction requires explicit placements");
  const targets = plan.targets.filter((target) => target.kind === "set");
  const matches = async (target) => {
    const block = (await mc.read("block@1", { at: target.at })).value?.block;
    const name = typeof target.block === "string" ? target.block : target.block.name;
    return block?.name === name &&
      Object.entries(target.block.properties ?? {}).every(([key, value]) => block.properties?.[key] === value);
  };
  const blocked = new Set(plan.blocked.map(({ at }) => JSON.stringify(at)));
  let verified = 0;
  await mc.saveCheckpoint({ verified });
  for (const target of targets) {
    if (!await matches(target) && !blocked.has(JSON.stringify(target.at))) {
      try {
        await mc.call("place@1", { at: target.at, block: target.block, replace: false });
      } catch (error) {
        if (error.dispatch !== "not_sent" ||
            !["MISSING_MATERIAL", "CONFLICT", "UNREACHABLE"].includes(error.code)) throw error;
      }
    }
    if (await matches(target)) await mc.saveCheckpoint({ verified: ++verified });
  }
  const remaining = [];
  for (const target of targets) {
    if (!await matches(target)) remaining.push(target.at);
  }
  if (remaining.length) mc.decide("Construction has unsatisfied target cells", { verified, remaining });
  return { verified, remaining };
}
`;
