import { CompilerContext } from "../../src/context/context";
import { createABI } from "../../src/generator/createABI";
import { writeProgram } from "../../src/generator/writeProgram";
import type { AstModule } from "../../src/ast/ast";
import { openContext } from "../../src/context/store";
import { resolveAllocations } from "../../src/storage/resolveAllocation";
import { featureEnable } from "../../src/config/features";
import { resolveDescriptors } from "../../src/types/resolveDescriptors";
import { resolveSignatures } from "../../src/types/resolveSignatures";
import { resolveStatements } from "../../src/types/resolveStatements";
import { resolveErrors } from "../../src/types/resolveErrors";
import type { FactoryAst } from "../../src/ast/ast-helpers";
import { getParser } from "../../src/grammar/grammar";

export function createContext(
    program: AstModule,
    factoryAst: FactoryAst,
): CompilerContext {
    let ctx = new CompilerContext();
    ctx = openContext(
        ctx,
        /*sources=*/ [],
        /*funcSources=*/ [],
        getParser(factoryAst, "new"),
        [program],
    );
    return ctx;
}

/**
 * Replicates the `precompile` pipeline.
 */
export function precompile(
    ctx: CompilerContext,
    factoryAst: FactoryAst,
): CompilerContext {
    ctx = resolveDescriptors(ctx, factoryAst);
    ctx = resolveSignatures(ctx, factoryAst);
    ctx = resolveAllocations(ctx);
    ctx = resolveStatements(ctx);
    ctx = resolveErrors(ctx, factoryAst);
    return ctx;
}

/**
 * Enables compiler's features.
 */
export function enableFeatures(
    ctx: CompilerContext,
    ...features: ["inline" | "debug" | "masterchain" | "external"]
): CompilerContext {
    return features.reduce((accCtx, feature) => {
        return featureEnable(accCtx, feature);
    }, ctx);
}

/**
 * Replicates the `compile` pipeline.
 */
export async function compile(ctx: CompilerContext, contractName: string) {
    const abi = createABI(ctx, contractName);
    const output = await writeProgram(
        ctx,
        abi,
        `tact_check_${contractName}`,
        {}, //ContractCodes
        false,
    );
    return { output, ctx };
}
