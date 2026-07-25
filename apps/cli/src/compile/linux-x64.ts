// Per-triple compile entry point. The napi transport artifact is gone (ADR-0012),
// so every triple now embeds the same pure-JS CLI; the entry points stay one-per-triple
// because the release matrix builds each on its own native runner.
await import("../index.js");
