import { defineRule, eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

const criticalMethods = new Set(["saveNote", "updateNote", "deleteNote", "addAgentMessage"]);

function isStringLiteral(node: ESTree.Node): node is ESTree.StringLiteral {
  return node.type === "Literal" && typeof node.value === "string";
}

function propertyName(node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression") return null;

  if (!node.computed && node.property.type === "Identifier") return node.property.name;

  if (node.computed && isStringLiteral(node.property)) return node.property.value;

  return null;
}

function unwrap(node: ESTree.Node): ESTree.Node {
  if (node.type === "ChainExpression" || node.type === "ParenthesizedExpression")
    return unwrap(node.expression);

  if (node.type === "AwaitExpression") return unwrap(node.argument);

  if (node.type === "UnaryExpression" && node.operator === "void") return unwrap(node.argument);

  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const method = propertyName(node.callee);

    if (method === "catch" || method === "finally") return unwrap(node.callee.object);
  }

  return node;
}

const rule = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      discarded:
        "Check or return the {{method}} result. Awaiting it handles rejection but does not handle a resolved failure.",
    },
  },
  createOnce(context) {
    return {
      ExpressionStatement(statement) {
        const call = unwrap(statement.expression);

        if (call.type !== "CallExpression") return;
        const callee = unwrap(call.callee);

        if (callee.type !== "MemberExpression") return;
        const method = propertyName(callee);

        if (method === null || !criticalMethods.has(method)) return;
        const api = unwrap(callee.object);

        if (api.type !== "MemberExpression" || propertyName(api) !== "electronAPI") return;
        const receiver = unwrap(api.object);

        if (receiver.type !== "Identifier" || receiver.name !== "window") return;
        let scope = context.sourceCode.getScope(call);

        while (true) {
          if (scope.set.get("window")?.defs.length) return;

          if (scope.upper === null) break;
          scope = scope.upper;
        }

        context.report({ node: call, messageId: "discarded", data: { method } });
      },
    };
  },
});

export default eslintCompatPlugin({
  meta: { name: "gristmill" },
  rules: { "no-discarded-critical-write": rule },
});
