# Progress-bounded AI assistance

Status: planned

## Scope

Add optional character-event summaries and plot recaps after basic reading and data capabilities are stable. This specification defines extension constraints, not a foundation-stage runtime dependency. Model providers, embedding models, and vector storage are selected in the AI stage.

## Interfaces

Consume stable book identity, content version, and a read-only position/range interface from [Library](library.md) and [Reader](reader.md). Separate content retrieval, embedding/index storage, and generation provider interfaces so the reader does not depend on any provider being configured.

Derived records identify their book/content version, source ranges, and generation cutoff. Exact schemas and provider contracts belong to the AI implementation task; do not add speculative tables or services during foundation work.

## Behavior

### Reading boundary

Capture the requested cutoff from the application's current reading position, not the maximum position ever reached. Build retrieval candidates from text ranges at or before that cutoff. Exclude later text before embedding or assembling retrieved context; a chunk spanning the cutoff must be trimmed or excluded. Later material must not enter generated summaries through indexes, cached outputs, metadata, or provider tools.

Tie intermediate summaries and generated outputs to the same content version and covered ranges. An output created at a later cutoff is ineligible for an earlier reading position. Changing source, replacing a file, or changing the content version invalidates incompatible derived data.

These controls restrict supplied evidence; they do not prove that a model has no prior knowledge of a published book. Generation must use the allowed evidence, attach source locations to claims, and express insufficient evidence rather than invent events. Verify spoiler behavior with controlled books and adversarial prompts before describing it as reliable.

### Features and execution

Character-event summaries organize a character's actions through the selected cutoff and link back to supporting passages. Plot recaps describe the eligible story range for returning readers. Both are derived views; they never rewrite original text or reading history.

Generation is user-triggered, cancellable, and retryable. Failure, missing provider configuration, or a rebuilding index does not block reading. Before a remote provider is used, the feature identifies the provider and eligible content range being sent; credentials remain in device-local secure storage.

Prefer a replaceable local index for reconstructible embeddings and retrieval metadata. Vector technology is an implementation choice, not a reason to bundle a server into the base reader. Indexes and generated content follow [Sync's data ownership rules](sync.md).

## Acceptance

- Put a distinctive event after the cutoff and verify it is absent from retrieval candidates, prompt context, reused summaries, and generated claims.
- Test a cutoff inside a chunk, a backward reading move, and a previously generated later recap.
- Change book content or source and verify stale indexes and outputs cannot supply mismatched evidence.
- Check passage citations, insufficient-evidence behavior, cancellation, retry, and reading with the AI subsystem disabled.
