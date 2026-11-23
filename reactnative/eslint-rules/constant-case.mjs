// A module-level const that holds data all the way down is a constant, and is
// named in SCREAMING_CASE. Data is a literal (regular expressions included), a
// template literal of data, arithmetic on data, an object or array literal of
// data, Object.freeze of data, a type assertion of data, or a reference to
// another SCREAMING_CASE name. Anything else, such as a function, a call or a
// reference to a camelCase name, makes the value behaviour or computed state,
// which keeps its own name. Only plain names declared at the top of a module
// are checked; the check is syntactic and needs no type information.
const SCREAMING_CASE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

const UNARY = new Set(["-", "+", "~", "!"]);
const BINARY = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<<",
  ">>",
  ">>>",
  "&",
  "|",
  "^",
]);

function isData(node) {
  switch (node.type) {
    case "Literal":
      return true;
    case "Identifier":
      return SCREAMING_CASE.test(node.name);
    case "TemplateLiteral":
      return node.expressions.every(isData);
    case "UnaryExpression":
      return UNARY.has(node.operator) && isData(node.argument);
    case "BinaryExpression":
      return (
        BINARY.has(node.operator) && isData(node.left) && isData(node.right)
      );
    case "ArrayExpression":
      return node.elements.every((element) => !element || isData(element));
    case "ObjectExpression":
      return node.properties.every((property) =>
        property.type === "SpreadElement"
          ? isData(property.argument)
          : property.kind === "init" &&
            !property.method &&
            (!property.computed || isData(property.key)) &&
            isData(property.value),
      );
    case "SpreadElement":
      return isData(node.argument);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
      return isData(node.expression);
    case "CallExpression":
      return (
        node.callee.type === "MemberExpression" &&
        !node.callee.computed &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Object" &&
        node.callee.property.name === "freeze" &&
        node.arguments.length === 1 &&
        isData(node.arguments[0])
      );
    default:
      return false;
  }
}

export const constantCaseRule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Name module-level data constants in SCREAMING_CASE.",
    },
    schema: [
      {
        type: "object",
        properties: {
          // Exported names a file is required to have, such as `version` in
          // every migration step.
          allowExports: { type: "array", items: { type: "string" } },
          // A naming rule of the files this is set for, said with the report.
          note: { type: "string" },
        },
        required: ["allowExports", "note"],
        additionalProperties: false,
      },
    ],
    messages: {
      constant:
        "`{{name}}` holds fixed data, so it is a constant: name it in SCREAMING_CASE, with a name that is clear without reading its uses. If you think this is a false positive, tell a maintainer rather than working around it.{{note}}",
    },
  },
  create(context) {
    const { allowExports, note } = context.options[0];

    function check(declaration, exported) {
      if (declaration?.type !== "VariableDeclaration") return;
      if (declaration.kind !== "const") return;
      for (const { id, init } of declaration.declarations) {
        if (id.type !== "Identifier" || !init) continue;
        if (SCREAMING_CASE.test(id.name)) continue;
        if (exported && allowExports.includes(id.name)) continue;
        if (isData(init))
          context.report({
            node: id,
            messageId: "constant",
            data: { name: id.name, note: note && ` ${note}` },
          });
      }
    }

    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type === "ExportNamedDeclaration")
            check(statement.declaration, true);
          else check(statement, false);
        }
      },
    };
  },
};
