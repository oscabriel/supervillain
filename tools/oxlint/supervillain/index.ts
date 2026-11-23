import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

const noCommentsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow every comment: line, block, doc, shebang and directive alike.",
		},
		messages: {
			comment:
				"Code carries no comments. Put design choices in docs/adr/, known workarounds in docs/issues/, and domain terms in GLOSSARY.md.",
		},
	},
	createOnce(context) {
		return {
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					context.report({ loc: comment.loc, messageId: "comment" });
				}
			},
		};
	},
});

export default eslintCompatPlugin({
	meta: { name: "supervillain" },
	rules: { "no-comments": noCommentsRule },
});
