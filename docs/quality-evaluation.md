# Independent review-quality evaluation

This benchmark separates evidence delivery and valid result assembly from useful defect detection. It contains generic synthetic programs; no Collector source, credentials, private run identifiers, or company-specific behavior is included.

The evaluator does not call a model and does not claim that a deterministic test detects defects through AI. It executes an independent behavioral contract against a fixed synthetic module, then scores scenario claims from a separately produced review report.

## Create a review workspace

Run from the Review Mesh checkout with installed development dependencies:

```text
node --import tsx scripts/evaluate-quality.mjs create state buggy
node --import tsx scripts/evaluate-quality.mjs create state corrected
```

Other cases are `search` and `eligibility`. Each command returns a `workspace`, an `oraclePath`, a normal review `request`, and separate `adapter_requirements`. The workspace has only `engine.mjs` and `contract.md`. The oracle is in a sibling private directory, outside snapshot capture and the review tool's file boundary. Pass **only the request** to Review Mesh; do not include the creation command, variant, oracle path, proof output, expected result, or evaluator output in the review prompt. Use neutral model/lens names and the same prompts and policies for buggy and corrected variants.

Real scoring requires an OpenAI-compatible adapter configured in trusted configuration with `semantic_checkpoints = true`. This explicitly collects scenario checkpoints even for the small full-scope fixtures; a normal small full-scope tool review may otherwise produce no segment records. The request does not enable or override this trusted setting. Apply the same setting to both variants:

```toml
[adapters.evaluation]
type = "openai_compatible"
base_url_env = "EVALUATION_BASE_URL"
api_key_env = "EVALUATION_API_KEY"
semantic_checkpoints = true
```

The programs exercise three explicit contracts:

- A selected value must remain stable for later records with the same key, including an empty associated collection.
- A retrieval chunk size must not restrict the set of searchable records.
- Ineligible positions must have the same outcome whether old interval data is present or absent.

These are synthetic contracts, not an assertion that every production bounded search or missing pre-cutover record must behave the same way. Corrected implementations and normal-path probes provide false-positive controls.

## Verify behavior independently

```text
node --import tsx scripts/evaluate-quality.mjs verify ORACLE_PATH
```

This executes registered fixture code in a fresh Node process with a three-second limit, bounded input/output, no shell, and no inherited credentials. It verifies source/contract checksums and the oracle definition before executing. Buggy variants must violate at least one contract probe; corrected variants must satisfy every probe. The probes and expected results stay outside the reviewed workspace.

Review Mesh itself remains read-only and does not execute these programs. Runtime results produced here have evaluator provenance; model scenario checks retain `model_reasoning` provenance until independently verified.

## Score a real review artifact

Run a separately authorized review against the returned request, then retrieve its raw JSON report:

```text
review-mesh report RUN_ID --format json --raw
node --import tsx scripts/evaluate-quality.mjs score ORACLE_PATH RAW_REPORT_JSON_PATH
```

The scorer reads accepted reviewers' findings and their checkpoint scenario checks at `reviewer.segment.data.data.scenario_checks` (it also accepts the unnested checkpoint form for evaluator adapters):

```json
{
  "path": "engine.mjs",
  "start_line": 1,
  "end_line": 3,
  "input": {},
  "expected": null,
  "observed": null,
  "reasoning": "A concrete explanation of the path through the code.",
  "finding_id": "optional-linked-finding-id"
}
```

The illustrative empty input above is not a valid test case; reviewers construct inputs from the documented module contract. Scoring does not match defect names or title keywords. Credit requires all of:

1. A completed review containing a linked finding with trigger, affected behavior, outcome, and evidence at the relevant source location.
2. A valid model-supplied input whose actual execution matches the reported observation.
3. The independently implemented contract matching the reported expected output.
4. Expected and observed outputs differing for a defect claim.

Corrected pass claims also need independently verified boundary and control scenario classes. Arbitrary prose, fabricated observations, a complete source-delivery ledger, or a blanket pass do not satisfy that check. The evaluator retains an explicit limitation: it checks a runnable counterexample and source linkage, but does not automatically prove the entire free-form causal explanation. Review that explanation independently when promoting benchmark results.

Scoring requires a raw report whose context identifies the exact fixture workspace. The workspace and oracle must still match their registered source/contract/probe hashes. At most 128 scenario claims are executed per report. This is a bounded evaluation tool, not a runner for arbitrary user-supplied programs.

The response separately records infrastructure outcomes, verified/rejected scenarios, true positives, false negatives, unmatched findings, false positives on corrected controls, unsubstantiated passes, and unsupported overall clear outcomes. Incomplete reviewer drafts do not count as detections. A run that stays inconclusive is not automatically a successful quality evaluation. A keyword-only alleged defect remains unmatched rather than receiving credit.

## Release use

Run every buggy/corrected pair with the same frozen model identities, review prompts and budget policy. Record real run IDs, artifact digests, token usage and duration separately. Repeat with renamed/numerically varied hidden holdouts and larger neutral source context before drawing conclusions about robustness; the three bundled cases alone cannot establish general review accuracy. Keep model completion rate, defect recall, false positives, unsupported passes and cost as separate measures.

Unit tests cover the fixture/evaluator mechanisms using constructed result objects. They do **not** establish live model detection performance. No live model-quality score is claimed by adding or passing these tests.
