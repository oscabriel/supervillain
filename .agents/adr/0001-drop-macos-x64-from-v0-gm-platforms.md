# Drop macos-x64 from the v0 GM platform set

The product definition pinned the v0 GM platforms as Linux + macOS, x64 + arm64 (four
triples). The hello-iroh compile smoke (#3) proved the compiled-binary story on three of
them and surfaced a hard blocker on the fourth: `@number0/iroh` has **never published a
darwin-x64 native artifact** (checked 0.31.0, 0.35.0, 1.0.0-rc.1, 1.0.0; the
`@number0/iroh-darwin-x64` npm package exists only as stale `0.22.1-test*` builds). We
drop macos-x64 to named churn rather than build the binding ourselves: Intel Macs are a
sunsetting platform (last hardware shipped 2020; Apple has announced macOS 26 is the
final release to support them), upstream has deprioritized the target, and a vendored
napi-rs build would be a permanent release-pipeline maintenance tail for a shrinking
cohort. v0 GM platforms are therefore **linux-x64, linux-arm64, macos-arm64**. Intel-Mac
GMs get the same answer as Windows GMs: no native artifact, run the Linux one (a VM, or
wait for the trigger below). Players are unaffected (any ssh client, any OS).

**Revisit trigger:** a real Intel-Mac GM cohort *and* a same-version darwin-x64 artifact
— either upstream resuming publication (an upstream ask to n0-computer is cheap and
remains open) or a decision to self-build from iroh-ffi source on `macos-*-intel`
runners, which is feasible but was rejected at v0 for the maintenance cost.
