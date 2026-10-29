# Repository instructions

Do not modify `README.md` without an explicit user request.

For implementation details, speech markup, or vendored runtime maintenance,
read [DEVELOPMENT.md](DEVELOPMENT.md).

Before running scripts, tests, or benchmarks, check whether they make paid API
requests. Prefer offline checks when live inference is unnecessary. For paid
runs, state the planned request count and estimated cost, keep calls and retries
within the user's authorized scope and budget, and report actual cost when
available. Verify pricing rather than assuming a route is free.
