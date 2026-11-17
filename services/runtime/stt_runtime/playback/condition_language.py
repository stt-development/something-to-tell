"""Single parser authority for the documented Playback condition language."""

from lark import Lark, Tree

# Both Playback evaluation and executable export consume this grammar. Callers
# receive a syntax tree, never executable Python or target-language source.
_CONDITION_GRAMMAR = r"""
?start: expression
?expression: or_expression
?or_expression: or_expression OR and_expression -> boolean_or
              | and_expression
?and_expression: and_expression AND not_expression -> boolean_and
               | not_expression
?not_expression: NOT not_expression -> boolean_not
               | comparison
?comparison: atom NOT IN atom -> not_in
           | atom IN atom -> in_operator
           | atom OPERATOR atom -> comparison
           | atom
?atom: literal
     | path
     | function_call
     | "(" expression ")" -> grouped
function_call: NAME "(" [expression ("," expression)*] ")"
path: NAME ("." PATH_SEGMENT)+
?literal: TRUE -> true_literal
        | FALSE -> false_literal
        | NULL -> null_literal
        | ESCAPED_STRING -> string_literal
        | SIGNED_NUMBER -> number_literal

OR.3: "or"
AND.3: "and"
NOT.3: "not"
IN.3: "in"
TRUE.3: "true"
FALSE.3: "false"
NULL.3: "null"
OPERATOR: "===" | "==" | "!=" | "<=" | ">=" | "=>" | "=<" | "<>" | "<" | ">" | /[=~^%+*\/&|]+/ | /[A-Za-z_]+/
NAME: /[A-Za-z_][A-Za-z0-9_-]*/
PATH_SEGMENT: /[A-Za-z0-9_][A-Za-z0-9_-]*/

%import common.ESCAPED_STRING
%import common.SIGNED_NUMBER
%import common.WS
%ignore WS
"""

_PARSER = Lark(
    _CONDITION_GRAMMAR,
    parser="lalr",
    lexer="contextual",
    propagate_positions=True,
)


def parse_playback_condition(expression: str) -> Tree:
    """Parse one authored expression through the Playback-owned grammar."""

    return _PARSER.parse(expression.strip())


def is_supported_playback_state_path(path: str) -> bool:
    """Recognize the exact state path shapes shared by evaluation and export."""

    parts = path.split(".")
    if parts[0] in {"flags", "inventory", "visited"}:
        return len(parts) == 2
    if parts[0] == "items":
        return len(parts) == 4 and parts[2] == "holder" and parts[3] in {
            "kind",
            "node_id",
        }
    if parts[0] == "quests":
        return len(parts) == 3 and parts[2] == "status"
    if parts[0] == "dialogue":
        return len(parts) == 3 and parts[2] == "choices"
    return False
