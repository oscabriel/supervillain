import { Effect } from "effect";

interface Emitter<Name extends string> {
	readonly once: (name: Name, listener: () => void) => void;
}

export const nextEvent = <Name extends string>(
	emitter: Emitter<NoInfer<Name>>,
	name: Name
) =>
	Effect.callback<Name>((resume) => {
		emitter.once(name, () => {
			resume(Effect.succeed(name));
		});
	});
