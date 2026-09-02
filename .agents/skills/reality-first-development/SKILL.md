---
name: reality-first-development
description: >-
  Use this skill whenever a user is designing, rebuilding, simplifying, or evaluating a complex software system, especially an Agent, AI harness, memory system, real-time pipeline, plugin platform, autonomous runtime, or major refactor. Start from what actually runs and what can be measured, not from aspirational architecture or documentation. Use it even when the user asks only for architecture discussion: separate live evidence, tested behavior, static implementation, design assumptions, and dreams; reduce the design to a small auditable vertical slice; protect latency-critical paths; make long work asynchronous; and define concrete proof before recommending implementation.
---

# Reality-First Development

Build from observable behavior outward. A document, type, mock, or table can describe a possibility; it cannot prove that a product works. The job is to make the smallest useful behavior real, measurable, and easy to inspect before adding abstractions.

## Operating stance

Use these distinctions throughout the work:

- **Fact**: directly observed in the current environment, such as a command result, running process, HTTP response, database record, or reproducible test.
- **Tested behavior**: demonstrated by an automated test, with its test boundary stated. A mock test is not a device, provider, network, or production test.
- **Implementation**: code or configuration exists, but its runtime behavior is not yet demonstrated.
- **Assumption**: a design choice or dependency that still needs proof.
- **Aspiration**: a product wish that has not yet become an observable requirement.

Never upgrade a lower category into a higher one. Report these categories explicitly when they matter.

Prefer a system that is simple because its behavior has few possible paths over a system that is complicated and then surrounded by audit code. Keep enough operational history to explain, retry, cancel, and recover real work; do not build a parallel audit universe that duplicates business state.

## When the skill fires

Apply the workflow below for architecture proposals, rewrites, framework choices, Agent/Harness design, long-term memory, autonomous behavior, real-time interaction, plugin expansion, or broad refactors. It also applies when a user asks whether a design is "better", "scalable", "production-ready", or "AGI-like".

If the user asks for an explanation or evaluation, do not edit code. If the user asks to implement a change, use this workflow to scope and validate the change, then implement it within the repository's instructions.

## Scale the process to risk

Do not turn every change into a full architecture exercise. Choose the lightest process that can falsify the important claim:

- **Low risk**: local behavior change with one owner and no new runtime boundary. Inspect the local code, run focused tests, and report the result.
- **Medium risk**: shared behavior, persistence, protocol, or a new integration. Establish a small baseline, run composition/protocol checks, and verify one real entry point.
- **High risk**: core-loop rewrites, latency targets, memory, autonomy, permissions, sensing, external side effects, or deployment changes. Run the full reality-first workflow with isolated runtime evidence and product scenarios.

The process is successful when it prevents a wrong decision, not when it produces a long report. State why the selected depth is sufficient. Escalate when evidence reveals a new failure boundary.

## Workflow

### 1. Establish the current reality

Before proposing a new architecture, inspect the smallest set of evidence that can falsify the current story:

1. Read repository-local instructions and current-status files when present.
2. Check `git status --short` and preserve existing user changes.
3. Find real entry points, package scripts, configuration, dependency versions, and test commands.
4. Check the current runtime: processes, ports, service health, provider availability, device access, and required environment variables. Do not expose secrets.
5. Run one cheap smoke path from the real entry point. Use a temporary directory or isolated database when possible.
6. Run targeted tests and type checks. Verify that the command actually ran the intended scope.
7. Inspect recent structured runtime records or logs only with timestamp, code version, configuration, and environment in mind.
8. When deployability or reproducibility is part of the claim, repeat the smoke path from a clean directory or isolated data store. A run that reuses stale databases, caches, processes, credentials, or generated artifacts is not a clean-start proof.

For each observation, record the evidence level and boundary. A useful compact table is:

| Claim | Evidence | Level | Boundary |
|---|---|---|---|
| The system starts | real entry point output | live runtime | no external provider |
| Tool flow works | integration test | tested behavior | fake provider |
| Plugin is available | manifest parses | implementation | lifecycle not proven |
| Memory works | cross-session recall scenario | product evidence | tested dataset only |

If the environment cannot support a check, write **unverified** with the missing prerequisite. Do not silently substitute a mock.

### 2. Convert the vision into behavior

Turn each important wish into one observable scenario. Avoid vague acceptance language such as "human-like", "infinite extensibility", "real memory", or "autonomous" without a behavioral test.

For every scenario define:

- trigger and actor;
- visible or externally measurable result;
- latency or resource budget, if applicable;
- failure and degradation behavior;
- persistence or recovery requirement;
- a negative case proving the system does not fake success;
- the minimum evidence required to call it done.

Use a short priority order: **real user value, end-to-end latency, reliability, debuggability, then generality**. Generality that has not been exercised is an assumption, not a benefit.

### 3. Find the smallest vertical slice

Choose one complete path through the real system, not a collection of isolated modules. A good slice has:

```text
real input -> decision -> useful output -> external effect or stored result -> next event
```

For an Agent-like system, this normally means one input channel, one model provider, one streamed output, one tool, one asynchronous job, and one memory read/write path. Use real dependencies for the acceptance path and fakes only for fast deterministic tests.

Write explicit non-goals for the slice. Do not build a general plugin taxonomy, complete cognitive model, distributed deployment, or migration framework before the slice proves that the product needs it.

### 4. Govern the experiment

Treat a rewrite or architecture proposal as an experiment before treating it as a migration. Record:

- the baseline commit, effective configuration, environment/dependency versions, and exact commands;
- one falsifiable hypothesis, such as a latency, reliability, behavior, or maintenance improvement;
- the same scenarios and metrics for the baseline and the candidate;
- a time, resource, or scope budget for the experiment;
- a stop condition, rollback path, and deletion condition;
- the decision rule for continue, narrow, adopt, or abandon.

Do not migrate the whole system because a prototype feels cleaner. Keep the candidate beside the baseline while evidence is incomplete, and require it to win or meet an explicitly accepted tradeoff on the preselected scenarios. Do not change the rubric after seeing the result. If the candidate cannot demonstrate a material advantage, prefer deleting it or narrowing the claim over expanding it.

### 5. Keep the core small and auditable

Design around a few deep boundaries with one owner each. The exact names depend on the repository, but a lightweight Agent runtime often needs only:

- one subject mailbox or event queue;
- one foreground turn loop;
- one context builder;
- one model gateway;
- one tool/job broker;
- one output broker;
- one memory port;
- one sensor manager;
- one small runtime store.

Use these rules to test the design:

- one source of truth per durable state;
- one write path per side effect;
- one explicit lifecycle for a turn or job;
- typed boundaries at process or package edges;
- deterministic code owns state transitions, permissions, schemas, budgets, idempotency, cancellation, and retries;
- the model proposes language or structured intent; it does not directly own durable state or external authority;
- every background result returns through the same visible event path as other input;
- an auditor should be able to trace a behavior from one entry point without searching unrelated subscribers.

Avoid adding a module merely because a concept has a name. Extract a module when there is a stable ownership boundary, an independent failure mode, an independent scaling need, or repeated change pressure. Until then, keep the concept as data and a small policy function.

### 6. Separate the fast path from the slow path

For real-time interaction, define a hard end-to-end budget before selecting mechanisms. Measure at least:

```text
input final -> context ready -> model request -> first token
            -> first sentence -> output sink accepts first audio
```

The fast path should do one bounded model call and the minimum context work needed to begin useful output. Retrieval, memory consolidation, long tools, reflection, indexing, and complex planning belong on a slow path with their own deadlines.

When a stage misses its budget, degrade explicitly: use a smaller context, stale-but-labelled state, a short reply, or a queued follow-up. Do not wait indefinitely in the name of correctness.

Latency is only one operating boundary. Define capacity and backpressure before opening more concurrency:

- maximum mailbox depth, batch size, item age, and memory growth;
- per-provider and per-tool concurrency;
- what is prioritized, coalesced, sampled, delayed, or dropped when full;
- how a slow model, memory service, tool, or output sink affects new input;
- how overload is visible to the operator and to the foreground.

Exercise at least one sustained-load and one failure-under-load scenario. A fast single request is not proof of a real-time system.

### 7. Make asynchronous work first-class

Anything that can outlive a conversational turn is a `Job`, not a blocking function call. A job needs:

```text
accepted -> running -> succeeded | failed | cancelled | unknown
```

Persist the job before starting an external side effect. Return a stable job id quickly. Deliver completion, failure, timeout, and cancellation as events that can wake the foreground loop. On restart, unresolved running work becomes `unknown` until the provider or operator reconciles it; never infer success from process silence.

Keep one mailbox where possible. Use priority, batching, coalescing, and interruption rules inside the dispatcher instead of building disconnected queues whose ordering cannot be explained.

### 8. Treat memory as behavior, not storage

An archive, vector index, summary, or history replay is not proof of memory. Validate four separate behaviors:

1. **Write**: the system stores the right experience, with source and time.
2. **Recall**: a later relevant situation retrieves it within budget.
3. **Use**: the recalled item changes language, choice, or next action appropriately.
4. **Correction**: wrong, stale, or conflicting memories can be marked, revised, or ignored.

Keep conversation history, world facts, personal memories, commitments, and model-generated interpretations distinguishable. A memory service may be external, but its port must state latency, provenance, failure, and deletion behavior. Test across sessions or restarts; a second prompt in the same context is not long-term memory.

### 9. Make extension and sensing honest

Separate these states for every capability:

```text
declared -> loadable -> healthy -> callable -> result verified
```

Dynamic loading should load a bounded capability domain when needed, not expose every tool on every turn. Every provider needs lifecycle, version, health, timeout, resource, and failure semantics before the capability count grows.

For microphones, cameras, screens, and sensors, keep intent, authorization, device state, sampling, and delivered observation separate. The model may propose a sensing change; deterministic policy decides whether it is allowed. Continuous frames should be filtered and eventized before they wake the foreground loop.

### 10. Validate in layers

Use the cheapest evidence that answers the question, then climb the ladder:

1. static checks and unit tests for pure rules;
2. in-process composition with explicit fake boundaries;
3. subprocess and protocol tests;
4. isolated real-provider or real-device smoke tests;
5. end-to-end product scenarios with latency and resource measurements;
6. cross-session, restart, failure, and interruption tests.

Label each result. A passing mock test cannot close a real-device requirement. A historical log can prove that something happened before, but not that the current checkout can reproduce it.

For behavior influenced by a model, test invariants and outcomes rather than exact wording. Keep prompt tests for stable semantic rules, not incidental phrases.

For user-facing Agent behavior, add a small scenario suite covering the behavior that architecture diagrams cannot prove:

- cross-session recall and appropriate non-recall;
- memory correction and stale information;
- interruption, batching, silence, and recovery from partial output;
- tool success, tool failure, timeout, cancellation, and unknown result;
- unavailable model, memory, provider, device, and network;
- behavior under sustained queue pressure;
- autonomous activity with a reason, boundary, and cancellation path.

Use automated checks for invariants and metrics, and human evaluation for naturalness or person-like interaction. Keep the rubric stable, include negative cases, and compare against the baseline when evaluating a rewrite.

### 11. Keep the system operable

Make the running system diagnosable without recreating it from folklore:

- expose the effective build/commit, configuration profile, dependency versions, and capability status;
- attach correlation ids and timestamps to turns, jobs, external calls, and callbacks;
- redact credentials and sensitive content by default, with bounded retention;
- provide operator actions for inspect, cancel, retry, disable, and reconcile unknown work;
- make health checks test the real dependency boundary, not only that a manifest parses;
- detect drift between code, configuration, prompts, protocol, and tests;
- distinguish current evidence from historical logs and generated artifacts.

Operational records should explain what happened and what to do next. They should not become a second business state machine.

### 12. Keep the documentation honest

Update documentation only with facts that can be traced to a command, test, runtime artifact, or explicit decision. Every status claim should answer:

- what was observed;
- under which checkout/configuration/environment;
- what was not tested;
- what happens next.

Keep aspirational design in a clearly marked proposal. Do not let a proposal authorize implementation implicitly. When code, tests, configuration, and logs disagree, report the drift and establish a new baseline instead of choosing the most convenient interpretation.

## Architecture review questions

Use these questions to challenge a design before implementation:

- What is the first real user-visible behavior, and can it run today?
- Which claim is only supported by documentation or a mock?
- What is the smallest complete vertical slice?
- How many synchronous model calls are on the latency-critical path?
- Which work is allowed to continue after the turn ends?
- Who owns each durable state and each external side effect?
- Can one entry point explain event ordering and failure recovery?
- What is the explicit behavior when memory, model, provider, device, or network is unavailable?
- How is a false success prevented?
- What is the deletion, cancellation, restart, and unknown-result behavior?
- Which abstraction would disappear if the next real scenario were removed?
- What evidence would make us delete or simplify this mechanism?
- What is the smallest process depth that can falsify this claim?
- What is the baseline, hypothesis, comparison metric, stop condition, and rollback path?
- Can the result be reproduced from a clean environment without stale state?
- What happens when the mailbox, memory, provider, device, or output sink is overloaded?
- Can an operator inspect, cancel, retry, or reconcile the work without editing the database?

If the answers require a large matrix of parallel states or a second system whose only purpose is to audit the first, simplify the design before implementing it.

## Required output

For an architecture or framework evaluation, structure the response as:

1. **Current reality**: facts, tested behavior, implementation, assumptions, and unverified dependencies.
2. **Risk level**: why the selected process depth is enough.
3. **Verdict**: what is better, worse, or unresolved, with the reason.
4. **Smallest viable architecture**: the few boundaries and the first vertical slice.
5. **Fast/slow path**: latency budget, capacity, asynchronous jobs, queue behavior, and degradation.
6. **Experiment contract**: baseline, hypothesis, comparison, stop condition, rollback, and deletion rule.
7. **Evidence plan**: exact checks by layer, including clean-runtime and real dependency checks.
8. **Behavior and operations**: product scenarios, human evaluation where needed, health, drift, and operator recovery.
9. **Risks and deletion criteria**: what may fail and when to remove complexity.
10. **Decision**: implement, prototype beside the existing system, defer, or stop; state the reversible next step.

For implementation work, preserve the repository's required delivery format. Add the same evidence distinctions to the change summary, and do not claim real integration or product completion from mocks alone.
