import * as A from "../ast/ast";
import { CompilerContext } from "../context/context";
import { isAssignable } from "./subtyping";
import {
    tryExtractPath,
    FactoryAst,
    eqNames,
    isWildcard,
    isSelfId,
    idText,
    selfId,
} from "../ast/ast-helpers";
import {
    idTextErr,
    throwCompilationError,
    throwConstEvalError,
    throwInternalCompilerError,
} from "../error/errors";
import {
    getAllStaticFunctions,
    getStaticConstant,
    getType,
    hasStaticConstant,
    resolveTypeRef,
    getAllTypes,
} from "./resolveDescriptors";
import { getExpType, resolveExpression } from "./resolveExpression";
import { FunctionDescription, printTypeRef, TypeRef } from "./types";
import { evalConstantExpression } from "../optimizer/constEval";
import { ensureInt } from "../optimizer/interpreter";
import { crc16 } from "../utils/crc16";
import { SrcInfo } from "../grammar";
import { AstUtil, getAstUtil } from "../ast/util";

export type StatementContext = {
    root: SrcInfo;
    funName: string | null;
    returns: TypeRef;
    vars: Map<string, TypeRef>;
    requiredFields: string[];
};

export function emptyContext(
    root: SrcInfo,
    funName: string | null,
    returns: TypeRef,
): StatementContext {
    return {
        root,
        funName,
        returns,
        vars: new Map(),
        requiredFields: [],
    };
}

function checkVariableExists(
    ctx: CompilerContext,
    sctx: StatementContext,
    name: A.AstId,
): void {
    if (sctx.vars.has(idText(name))) {
        throwCompilationError(
            `Variable already exists: ${idTextErr(name)}`,
            name.loc,
        );
    }
    // Check if the user tries to shadow the current function name
    if (sctx.funName === idText(name)) {
        throwCompilationError(
            `Variable cannot have the same name as its enclosing function: ${idTextErr(name)}`,
            name.loc,
        );
    }
    if (hasStaticConstant(ctx, idText(name))) {
        if (name.loc.origin === "stdlib") {
            const constLoc = getStaticConstant(ctx, idText(name)).loc;
            throwCompilationError(
                `Constant ${idTextErr(name)} is shadowing an identifier defined in the Tact standard library: pick a different constant name`,
                constLoc,
            );
        } else {
            throwCompilationError(
                `Variable ${idTextErr(name)} is trying to shadow an existing constant with the same name`,
                name.loc,
            );
        }
    }
}

function addRequiredVariables(
    name: string,
    src: StatementContext,
): StatementContext {
    if (src.requiredFields.find((v) => v === name)) {
        throwInternalCompilerError(`Variable already exists: ${name}`); // Should happen earlier
    }
    return {
        ...src,
        requiredFields: [...src.requiredFields, name],
    };
}

function removeRequiredVariable(
    name: string,
    src: StatementContext,
): StatementContext {
    if (!src.requiredFields.find((v) => v === name)) {
        throwInternalCompilerError(`Variable is not required: ${name}`); // Should happen earlier
    }
    const filtered = src.requiredFields.filter((v) => v !== name);
    return {
        ...src,
        requiredFields: filtered,
    };
}

export function addVariable(
    name: A.AstId,
    ref: TypeRef,
    ctx: CompilerContext,
    sctx: StatementContext,
): StatementContext {
    checkVariableExists(ctx, sctx, name); // Should happen earlier
    if (isWildcard(name)) {
        return sctx;
    }
    return {
        ...sctx,
        vars: new Map(sctx.vars).set(idText(name), ref),
    };
}

function processCondition(
    condition: A.AstStatementCondition,
    sctx: StatementContext,
    ctx: CompilerContext,
): {
    ctx: CompilerContext;
    sctx: StatementContext;
    returnAlwaysReachable: boolean;
} {
    // Process expression
    ctx = resolveExpression(condition.condition, sctx, ctx);
    let initialCtx = sctx;

    // Simple if
    if (condition.falseStatements === null && condition.elseif === null) {
        const r = processStatements(condition.trueStatements, initialCtx, ctx);
        ctx = r.ctx;
        return { ctx, sctx: initialCtx, returnAlwaysReachable: false };
    }

    // Simple if-else
    const processedCtx: StatementContext[] = [];
    const returnAlwaysReachableInAllBranches: boolean[] = [];

    // Process true branch
    const r = processStatements(condition.trueStatements, initialCtx, ctx);
    ctx = r.ctx;
    processedCtx.push(r.sctx);
    returnAlwaysReachableInAllBranches.push(r.returnAlwaysReachable);

    // Process else/elseif branch
    if (condition.falseStatements !== null && condition.elseif === null) {
        // if-else
        const r = processStatements(condition.falseStatements, initialCtx, ctx);
        ctx = r.ctx;
        processedCtx.push(r.sctx);
        returnAlwaysReachableInAllBranches.push(r.returnAlwaysReachable);
    } else if (
        condition.falseStatements === null &&
        condition.elseif !== null
    ) {
        // if-else if
        const r = processCondition(condition.elseif, initialCtx, ctx);

        ctx = r.ctx;
        processedCtx.push(r.sctx);
        returnAlwaysReachableInAllBranches.push(r.returnAlwaysReachable);
    } else {
        throwInternalCompilerError("Impossible");
    }

    // Merge statement contexts
    const removed: string[] = [];
    for (const f of initialCtx.requiredFields) {
        let found = false;
        for (const c of processedCtx) {
            if (c.requiredFields.find((v) => v === f)) {
                found = true;
                break;
            }
        }
        if (!found) {
            removed.push(f);
        }
    }
    for (const r of removed) {
        initialCtx = removeRequiredVariable(r, initialCtx);
    }

    return {
        ctx,
        sctx: initialCtx,
        returnAlwaysReachable: returnAlwaysReachableInAllBranches.every(
            (x) => x,
        ),
    };
}

// Precondition: `self` here means a contract or a trait,
// and not a `self` parameter of a mutating method
export function isLvalue(path: A.AstId[], ctx: CompilerContext): boolean {
    const headId = path[0]!;
    if (isSelfId(headId) && path.length > 1) {
        // we can be dealing with a contract/trait constant `self.constFoo`
        const selfTypeRef = getExpType(ctx, headId);
        if (selfTypeRef.kind == "ref") {
            const contractTypeDescription = getType(ctx, selfTypeRef.name);
            return (
                contractTypeDescription.constants.findIndex((constDescr) =>
                    eqNames(path[1]!, constDescr.name),
                ) === -1
            );
        } else {
            return true;
        }
    } else {
        // if the head path symbol is a global constant, then the whole path expression is a constant
        return !hasStaticConstant(ctx, idText(headId));
    }
}

function processStatements(
    statements: readonly A.AstStatement[],
    sctx: StatementContext,
    ctx: CompilerContext,
): {
    ctx: CompilerContext;
    sctx: StatementContext;
    returnAlwaysReachable: boolean;
} {
    // Process statements

    let returnAlwaysReachable = false;
    for (const s of statements) {
        // Check for unreachable
        if (returnAlwaysReachable) {
            throwCompilationError("Unreachable statement", s.loc);
        }

        // Process statement
        switch (s.kind) {
            case "statement_let":
                {
                    // Process expression
                    ctx = resolveExpression(s.expression, sctx, ctx);

                    // Check variable name
                    checkVariableExists(ctx, sctx, s.name);

                    // Check type
                    const expressionType = getExpType(ctx, s.expression);
                    if (s.type !== null) {
                        const variableType = resolveTypeRef(ctx, s.type);
                        if (!isAssignable(expressionType, variableType)) {
                            throwCompilationError(
                                `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "${printTypeRef(variableType)}"`,
                                s.loc,
                            );
                        }
                        sctx = addVariable(s.name, variableType, ctx, sctx);
                    } else {
                        if (expressionType.kind === "null") {
                            throwCompilationError(
                                `Cannot infer type for ${idTextErr(s.name)}`,
                                s.loc,
                            );
                        }
                        if (expressionType.kind === "void") {
                            throwCompilationError(
                                `The inferred type of variable ${idTextErr(s.name)} is "void", which is not allowed`,
                                s.loc,
                            );
                        }
                        sctx = addVariable(s.name, expressionType, ctx, sctx);
                    }
                }
                break;
            case "statement_assign":
                {
                    const tempSctx = { ...sctx, requiredFields: [] };
                    // Process lvalue
                    ctx = resolveExpression(s.path, tempSctx, ctx);
                    const path = tryExtractPath(s.path);
                    if (path === null) {
                        throwCompilationError(
                            `Assignments are allowed only into path expressions, i.e. identifiers, or sequences of direct contract/struct/message accesses, like "self.foo" or "self.structure.field"`,
                            s.path.loc,
                        );
                    }
                    if (!isLvalue(path, ctx)) {
                        throwCompilationError(
                            "Modifications of constant expressions are not allowed",
                            s.path.loc,
                        );
                    }

                    // Process expression
                    ctx = resolveExpression(s.expression, sctx, ctx);

                    // Check type
                    const expressionType = getExpType(ctx, s.expression);
                    const tailType = getExpType(ctx, s.path);
                    if (!isAssignable(expressionType, tailType)) {
                        throwCompilationError(
                            `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "${printTypeRef(tailType)}"`,
                            s.loc,
                        );
                    }

                    // Mark as assigned
                    if (path.length === 2 && path[0]!.text === "self") {
                        const field = path[1]!.text;
                        if (
                            sctx.requiredFields.findIndex((v) => v === field) >=
                            0
                        ) {
                            sctx = removeRequiredVariable(field, sctx);
                        }
                    }
                }
                break;
            case "statement_augmentedassign":
                {
                    // Process lvalue
                    const tempSctx = { ...sctx, requiredFields: [] };
                    ctx = resolveExpression(s.path, tempSctx, ctx);
                    const path = tryExtractPath(s.path);
                    if (path === null) {
                        throwCompilationError(
                            `Assignments are allowed only into path expressions, i.e. identifiers, or sequences of direct contract/struct/message accesses, like "self.foo" or "self.structure.field"`,
                            s.path.loc,
                        );
                    }
                    if (!isLvalue(path, ctx)) {
                        throwCompilationError(
                            "Modifications of constant expressions are not allowed",
                            s.path.loc,
                        );
                    }

                    // Process expression
                    ctx = resolveExpression(s.expression, sctx, ctx);

                    // Check type
                    const tailType = getExpType(ctx, s.path);
                    const expressionType = getExpType(ctx, s.expression);

                    // Check if any of the types is not ref or is optional or types themselves don't match
                    if (tailType.kind !== "ref" || tailType.optional) {
                        throwCompilationError(
                            `Type error: invalid type ${printTypeRef(tailType)} for augmented assignment`,
                            s.path.loc,
                        );
                    }
                    if (
                        expressionType.kind !== "ref" ||
                        expressionType.optional
                    ) {
                        throwCompilationError(
                            `Type error: invalid type ${printTypeRef(expressionType)} for augmented assignment`,
                            s.expression.loc,
                        );
                    }

                    if (s.op === "&&" || s.op === "||") {
                        if (tailType.name !== "Bool") {
                            throwCompilationError(
                                `Type error: Augmented assignment ${s.op}= is only allowed for Bool type`,
                                s.path.loc,
                            );
                        }
                        if (expressionType.name !== "Bool") {
                            throwCompilationError(
                                `Type error: Augmented assignment ${s.op}= is only allowed for Bool type`,
                                s.expression.loc,
                            );
                        }
                    } else {
                        if (tailType.name !== "Int") {
                            throwCompilationError(
                                `Type error: Augmented assignment ${s.op}= is only allowed for Int type`,
                                s.path.loc,
                            );
                        }
                        if (expressionType.name !== "Int") {
                            throwCompilationError(
                                `Type error: Augmented assignment ${s.op}= is only allowed for Int type`,
                                s.expression.loc,
                            );
                        }
                    }
                }
                break;
            case "statement_expression":
                {
                    // Process expression
                    ctx = resolveExpression(s.expression, sctx, ctx);
                    // take `throw` and `throwNative` into account when doing
                    // return-reachability analysis
                    if (
                        s.expression.kind === "static_call" &&
                        ["throw", "nativeThrow"].includes(
                            idText(s.expression.function),
                        )
                    ) {
                        returnAlwaysReachable = true;
                    }
                }
                break;
            case "statement_condition":
                {
                    // Process condition (expression resolved inside)
                    const r = processCondition(s, sctx, ctx);
                    ctx = r.ctx;
                    sctx = r.sctx;
                    returnAlwaysReachable ||= r.returnAlwaysReachable;

                    // Check type
                    const expressionType = getExpType(ctx, s.condition);
                    if (
                        expressionType.kind !== "ref" ||
                        expressionType.name !== "Bool" ||
                        expressionType.optional
                    ) {
                        throwCompilationError(
                            `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "Bool"`,
                            s.loc,
                        );
                    }
                }
                break;
            case "statement_return":
                {
                    if (s.expression) {
                        // Process expression
                        ctx = resolveExpression(s.expression, sctx, ctx);

                        // Check type
                        const expressionType = getExpType(ctx, s.expression);

                        // Actually, we might relax the following restriction in the future
                        // Because `return foo()` means `foo(); return` for a void-returning function
                        // And `return foo()` looks nicer when the user needs early exit from a function
                        // right after executing `foo()`
                        if (expressionType.kind == "void") {
                            throwCompilationError(
                                `'return' statement can only be used with non-void types`,
                                s.loc,
                            );
                        }
                        if (!isAssignable(expressionType, sctx.returns)) {
                            throwCompilationError(
                                `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "${printTypeRef(sctx.returns)}"`,
                                s.loc,
                            );
                        }
                    } else {
                        if (sctx.returns.kind !== "void") {
                            throwCompilationError(
                                `The function fails to return a result of type "${printTypeRef(sctx.returns)}"`,
                                s.loc,
                            );
                        }
                    }

                    // Check if all required variables are assigned
                    if (sctx.requiredFields.length > 0) {
                        if (sctx.requiredFields.length === 1) {
                            throwCompilationError(
                                `Field "${sctx.requiredFields[0]}" is not set`,
                                sctx.root,
                            );
                        } else {
                            throwCompilationError(
                                `Fields ${sctx.requiredFields.map((x) => '"' + x + '"').join(", ")} are not set`,
                                sctx.root,
                            );
                        }
                    }

                    returnAlwaysReachable = true;
                }
                break;
            case "statement_repeat":
                {
                    // Process expression
                    ctx = resolveExpression(s.iterations, sctx, ctx);

                    // Process statements
                    const r = processStatements(s.statements, sctx, ctx);
                    ctx = r.ctx;

                    // Check type
                    const expressionType = getExpType(ctx, s.iterations);
                    if (
                        expressionType.kind !== "ref" ||
                        expressionType.name !== "Int" ||
                        expressionType.optional
                    ) {
                        throwCompilationError(
                            `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "Int"`,
                            s.loc,
                        );
                    }
                }
                break;
            case "statement_until":
                {
                    // Process expression
                    ctx = resolveExpression(s.condition, sctx, ctx);

                    // Process statements
                    const r = processStatements(s.statements, sctx, ctx);
                    ctx = r.ctx;
                    // XXX a do-until loop is a weird place to always return from a function
                    // so we might want to issue a warning here
                    returnAlwaysReachable ||= r.returnAlwaysReachable;

                    // Check type
                    const expressionType = getExpType(ctx, s.condition);
                    if (
                        expressionType.kind !== "ref" ||
                        expressionType.name !== "Bool" ||
                        expressionType.optional
                    ) {
                        throwCompilationError(
                            `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "Bool"`,
                            s.loc,
                        );
                    }
                }
                break;
            case "statement_while":
                {
                    // Process expression
                    ctx = resolveExpression(s.condition, sctx, ctx);

                    // Process statements
                    const r = processStatements(s.statements, sctx, ctx);
                    ctx = r.ctx;
                    // a while loop might be executed zero times, so
                    // even if its body always returns from a function
                    // we don't care

                    // Check type
                    const expressionType = getExpType(ctx, s.condition);
                    if (
                        expressionType.kind !== "ref" ||
                        expressionType.name !== "Bool" ||
                        expressionType.optional
                    ) {
                        throwCompilationError(
                            `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "Bool"`,
                            s.loc,
                        );
                    }
                }
                break;
            case "statement_try":
                {
                    let initialSctx = sctx;

                    // Process inner statements
                    const r = processStatements(s.statements, sctx, ctx);
                    ctx = r.ctx;

                    // try-statement might not return from the current function
                    // because the control flow can go to the empty catch block
                    if (s.catchBlock === undefined) {
                        break;
                    }

                    let catchCtx = sctx;
                    // Process catchName variable for exit code
                    checkVariableExists(
                        ctx,
                        initialSctx,
                        s.catchBlock.catchName,
                    );
                    catchCtx = addVariable(
                        s.catchBlock.catchName,
                        { kind: "ref", name: "Int", optional: false },
                        ctx,
                        initialSctx,
                    );

                    // Process catch statements
                    const rCatch = processStatements(
                        s.catchBlock.catchStatements,
                        catchCtx,
                        ctx,
                    );
                    ctx = rCatch.ctx;
                    catchCtx = rCatch.sctx;
                    // if both catch- and try- blocks always return from the current function
                    // we mark the whole try-catch statement as always returning
                    returnAlwaysReachable ||=
                        r.returnAlwaysReachable && rCatch.returnAlwaysReachable;

                    // Merge statement contexts
                    const removed: string[] = [];
                    for (const f of initialSctx.requiredFields) {
                        if (!catchCtx.requiredFields.find((v) => v === f)) {
                            removed.push(f);
                        }
                    }
                    for (const r of removed) {
                        initialSctx = removeRequiredVariable(r, initialSctx);
                    }
                }
                break;
            case "statement_foreach": {
                let initialSctx = sctx; // Preserve initial context to use later for merging

                // Resolve map expression
                ctx = resolveExpression(s.map, sctx, ctx);
                const mapPath = tryExtractPath(s.map);
                if (mapPath === null) {
                    throwCompilationError(
                        `foreach is only allowed over maps that are path expressions, i.e. identifiers, or sequences of direct contract/struct/message accesses, like "self.foo" or "self.structure.field"`,
                        s.map.loc,
                    );
                }

                // Check if map is valid
                const mapType = getExpType(ctx, s.map);
                if (mapType.kind !== "map") {
                    throwCompilationError(
                        `foreach can only be used on maps, but "${mapPath.map((id) => id.text).join(".")}" has type "${printTypeRef(mapType)}"`,
                        s.map.loc,
                    );
                }

                let foreachSctx = sctx;

                // Add key and value to statement context
                if (!isWildcard(s.keyName)) {
                    checkVariableExists(ctx, initialSctx, s.keyName);
                    foreachSctx = addVariable(
                        s.keyName,
                        { kind: "ref", name: mapType.key, optional: false },
                        ctx,
                        initialSctx,
                    );
                }
                if (!isWildcard(s.valueName)) {
                    checkVariableExists(ctx, foreachSctx, s.valueName);
                    foreachSctx = addVariable(
                        s.valueName,
                        { kind: "ref", name: mapType.value, optional: false },
                        ctx,
                        foreachSctx,
                    );
                }

                // Process inner statements
                const r = processStatements(s.statements, foreachSctx, ctx);
                ctx = r.ctx;
                foreachSctx = r.sctx;

                // Merge statement contexts (similar to catch block merging)
                const removed: string[] = [];
                for (const f of initialSctx.requiredFields) {
                    if (!foreachSctx.requiredFields.find((v) => v === f)) {
                        removed.push(f);
                    }
                }
                for (const r of removed) {
                    initialSctx = removeRequiredVariable(r, initialSctx);
                }

                sctx = initialSctx; // Re-assign the modified initial context back to sctx after merging
                break;
            }
            case "statement_destruct": {
                // Process expression
                ctx = resolveExpression(s.expression, sctx, ctx);

                // Check variable names
                for (const [_, name] of s.identifiers.values()) {
                    checkVariableExists(ctx, sctx, name);
                }

                // Check type
                const expressionType = getExpType(ctx, s.expression);
                if (expressionType.kind !== "ref") {
                    throwCompilationError(
                        `Type '${printTypeRef(expressionType)}' cannot be destructured`,
                        s.expression.loc,
                    );
                }
                if (expressionType.optional) {
                    throwCompilationError(
                        `Type '${printTypeRef(expressionType)}' is optional and cannot be destructured`,
                        s.expression.loc,
                    );
                }
                const ty = getType(ctx, expressionType.name);
                if (ty.kind !== "struct") {
                    throwCompilationError(
                        `Type '${printTypeRef(expressionType)}' cannot be destructured`,
                        s.expression.loc,
                    );
                }

                // Check variables count
                if (
                    !s.ignoreUnspecifiedFields &&
                    s.identifiers.size !== ty.fields.length
                ) {
                    throwCompilationError(
                        `Expected ${ty.fields.length} fields, but got ${s.identifiers.size}`,
                        s.loc,
                    );
                }

                // Compare type with the specified one
                const typeRef = resolveTypeRef(ctx, s.type);
                if (typeRef.kind !== "ref") {
                    throwInternalCompilerError(
                        `Unexpected type kind: '${typeRef.kind}'`,
                        s.type.loc,
                    );
                }
                if (expressionType.name !== typeRef.name) {
                    throwCompilationError(
                        `Type mismatch: "${printTypeRef(expressionType)}" is not assignable to "${printTypeRef(typeRef)}"`,
                        s.expression.loc,
                    );
                }

                // Add variables
                s.identifiers.forEach(([field, name], _) => {
                    const f = ty.fields.find((f) => eqNames(f.name, field));
                    if (!f) {
                        throwCompilationError(
                            `Field '${idTextErr(field)}' not found in type '${expressionType.name}'`,
                            field.loc,
                        );
                    }
                    if (name.text !== "_") {
                        sctx = addVariable(name, f.type, ctx, sctx);
                    }
                });

                break;
            }
            case "statement_block": {
                const r = processStatements(s.statements, sctx, ctx);
                ctx = r.ctx;
                returnAlwaysReachable ||= r.returnAlwaysReachable;
                break;
            }
        }
    }

    return { ctx, sctx, returnAlwaysReachable };
}

function processFunctionBody(
    statements: readonly A.AstStatement[],
    sctx: StatementContext,
    ctx: CompilerContext,
): CompilerContext {
    const res = processStatements(statements, sctx, ctx);

    // Check if a non-void function always returns a value
    if (sctx.returns.kind !== "void" && !res.returnAlwaysReachable) {
        throwCompilationError(
            `Function does not always return a result. Adding 'return' statement(s) should fix the issue.`,
            res.sctx.root,
        );
    }

    // Check if all required variables are assigned
    if (res.sctx.requiredFields.length > 0) {
        if (res.sctx.requiredFields.length === 1) {
            throwCompilationError(
                `Field "${res.sctx.requiredFields[0]}" is not set`,
                res.sctx.root,
            );
        } else {
            throwCompilationError(
                `Fields ${res.sctx.requiredFields.map((x) => '"' + x + '"').join(", ")} are not set`,
                res.sctx.root,
            );
        }
    }

    return res.ctx;
}

export function resolveStatements(ctx: CompilerContext, Ast: FactoryAst) {
    const util = getAstUtil(Ast);

    // Process all static functions
    for (const f of getAllStaticFunctions(ctx)) {
        if (f.ast.kind === "function_def") {
            // Build statement context
            let sctx = emptyContext(f.ast.loc, f.name, f.returns);
            for (const p of f.params) {
                sctx = addVariable(p.name, p.type, ctx, sctx);
            }

            ctx = processFunctionBody(f.ast.statements, sctx, ctx);
        }
    }

    // Process all types
    for (const t of getAllTypes(ctx)) {
        // Process init
        if (t.init) {
            // Build statement context
            let sctx = emptyContext(t.init.ast.loc, null, { kind: "void" });

            // Self
            sctx = addVariable(
                selfId,
                { kind: "ref", name: t.name, optional: false },
                ctx,
                sctx,
            );

            // Required variables
            for (const f of t.fields) {
                if (f.default !== undefined) {
                    // NOTE: undefined is important here
                    continue;
                }
                if (isAssignable({ kind: "null" }, f.type)) {
                    continue;
                }
                sctx = addRequiredVariables(f.name, sctx);
            }

            // Args
            for (const p of t.init.params) {
                sctx = addVariable(p.name, p.type, ctx, sctx);
            }

            // Process
            ctx = processFunctionBody(t.init.ast.statements, sctx, ctx);
        }

        // Process receivers
        for (const f of t.receivers) {
            // Build statement context
            let sctx = emptyContext(f.ast.loc, null, { kind: "void" });
            sctx = addVariable(
                selfId,
                { kind: "ref", name: t.name, optional: false },
                ctx,
                sctx,
            );
            switch (f.selector.kind) {
                case "internal-binary":
                case "external-binary":
                    {
                        sctx = addVariable(
                            f.selector.name,
                            {
                                kind: "ref",
                                name: f.selector.type,
                                optional: false,
                            },
                            ctx,
                            sctx,
                        );
                    }
                    break;
                case "internal-empty":
                case "external-empty":
                case "external-comment":
                case "internal-comment":
                    // Nothing to add to context
                    break;
                case "internal-comment-fallback":
                case "external-comment-fallback":
                    {
                        sctx = addVariable(
                            f.selector.name,
                            { kind: "ref", name: "String", optional: false },
                            ctx,
                            sctx,
                        );
                    }
                    break;
                case "internal-fallback":
                case "external-fallback":
                    {
                        sctx = addVariable(
                            f.selector.name,
                            { kind: "ref", name: "Slice", optional: false },
                            ctx,
                            sctx,
                        );
                    }
                    break;
                case "bounce-fallback":
                    {
                        sctx = addVariable(
                            f.selector.name,
                            { kind: "ref", name: "Slice", optional: false },
                            ctx,
                            sctx,
                        );
                    }
                    break;
                case "bounce-binary":
                    {
                        sctx = addVariable(
                            f.selector.name,
                            f.selector.bounced
                                ? { kind: "ref_bounced", name: f.selector.type }
                                : {
                                      kind: "ref",
                                      name: f.selector.type,
                                      optional: false,
                                  },
                            ctx,
                            sctx,
                        );
                    }
                    break;
            }
            // Process
            ctx = processFunctionBody(f.ast.statements, sctx, ctx);
        }

        // Process functions
        const methodIds: Map<number, string> = new Map();
        for (const f of t.functions.values()) {
            if (
                f.ast.kind !== "native_function_decl" &&
                f.ast.kind !== "function_decl" &&
                f.ast.kind !== "asm_function_def"
            ) {
                // Build statement context
                let sctx = emptyContext(f.ast.loc, f.name, f.returns);

                if (f.self === null) {
                    throwInternalCompilerError(
                        "Self is null where it should not be",
                    );
                }
                sctx = addVariable(selfId, f.self, ctx, sctx);

                // Check for collisions in getter method IDs
                if (f.isGetter) {
                    const methodId = getMethodId(f, ctx, sctx, util);
                    const existing = methodIds.get(methodId);
                    if (existing) {
                        throwCompilationError(
                            `Method ID collision: getter '${f.name}' has the same method ID ${methodId} as getter '${existing}'\nPick a different getter name or explicit method ID to avoid collisions`,
                            f.ast.name.loc,
                        );
                    } else {
                        f.methodId = methodId;
                        methodIds.set(methodId, f.name);
                    }
                }

                for (const a of f.params) {
                    sctx = addVariable(a.name, a.type, ctx, sctx);
                }

                ctx = processFunctionBody(f.ast.statements, sctx, ctx);
            }
        }
    }

    return ctx;
}

function checkMethodId(methodId: bigint, loc: SrcInfo) {
    // method ids are 19-bit signed integers
    if (methodId < -(2n ** 18n) || methodId >= 2n ** 18n) {
        throwConstEvalError(
            "method ids must fit 19-bit signed integer range",
            true,
            loc,
        );
    }
    // method ids -4, -3, -2, -1, 0 ... 2^14 - 1 (inclusive) are kind of reserved by TVM
    // for the upper bound see F12_n (CALL) TVM instruction
    // and many small ids will be taken by internal procedures
    //
    // also, some ids are taken by the getters generated by Tact:
    // supported_interfaces -> 113617
    // lazy_deployment_completed -> 115390
    // get_abi_ipfs -> 121275
    if (-4n <= methodId && methodId < 2n ** 14n) {
        throwConstEvalError(
            "method ids cannot overlap with the TVM reserved ids: -4, -3, -2, -1, 0 ... 2^14 - 1",
            true,
            loc,
        );
    }
    const tactGeneratedGetterMethodIds = [113617n, 115390n, 121275n];
    if (tactGeneratedGetterMethodIds.includes(methodId)) {
        throwConstEvalError(
            `method ids cannot overlap with Tact reserved method ids: ${tactGeneratedGetterMethodIds.map((n) => n.toString()).join(", ")}`,
            true,
            loc,
        );
    }
}

function getMethodId(
    funcDescr: FunctionDescription,
    ctx: CompilerContext,
    sctx: StatementContext,
    util: AstUtil,
): number {
    const optMethodId = funcDescr.ast.attributes.find(
        (attr) => attr.type === "get",
    )?.methodId;

    if (optMethodId) {
        ctx = resolveExpression(optMethodId, sctx, ctx);
        const ty = getExpType(ctx, optMethodId);
        if (!(ty.kind === "ref" && ty.name === "Int")) {
            throwCompilationError(
                `Getter's method id expression must be of type "Int" but it has type "${printTypeRef(ty)}"`,
                optMethodId.loc,
            );
        }

        const methodId = ensureInt(
            evalConstantExpression(optMethodId, ctx, util),
        ).value;
        checkMethodId(methodId, optMethodId.loc);
        return Number(methodId);
    } else {
        const methodId = (crc16(funcDescr.name) & 0xffff) | 0x10000;
        checkMethodId(BigInt(methodId), funcDescr.ast.loc);
        return methodId;
    }
}
