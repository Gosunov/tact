import { getAstFactory } from "../../ast/ast-helpers";
import { CompilerContext } from "../../context/context";
import { openContext } from "../../context/store";
import { getParser } from "../../grammar";
import { evalComptimeExpressions } from "../../types/evalComptimeExpressions";
import { resolveDescriptors } from "../../types/resolveDescriptors";
import { getAllExpressionTypes } from "../../types/resolveExpression";
import { resolveSignatures } from "../../types/resolveSignatures";
import { resolveStatements } from "../../types/resolveStatements";
import { loadCases } from "../../utils/loadCases";

describe("interpreter-evaluation", () => {
    for (const r of loadCases(__dirname + "/success/")) {
        it(`${r.name} should pass compilation`, () => {
            const Ast = getAstFactory();
            let ctx = openContext(
                new CompilerContext(),
                [{ code: r.code, path: "<unknown>", origin: "user" }],
                [],
                getParser(Ast),
            );
            ctx = resolveDescriptors(ctx, Ast);
            ctx = resolveStatements(ctx);
            ctx = resolveSignatures(ctx, Ast);
            evalComptimeExpressions(ctx, Ast);
            expect(getAllExpressionTypes(ctx)).toMatchSnapshot();
        });
    }
});
