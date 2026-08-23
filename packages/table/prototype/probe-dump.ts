// PROTOTYPE helper — dump raw terminal query responses as escaped text.
process.stdout.write("\x1b_Ga=q,t=d,f=24,s=1,v=1,i=31;AAAA\x1b\\\x1b[c\x1b[16t");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
const chunks: string[] = [];
process.stdin.on("data", (c: Buffer) => {
	chunks.push(
		c
			.toString("latin1")
			.replace(/\x1b/g, "ESC")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n"),
	);
});
setTimeout(() => {
	require("node:fs").writeFileSync("/tmp/probe-dump-out.txt", JSON.stringify(chunks, null, 2));
	process.exit(0);
}, 1200);
