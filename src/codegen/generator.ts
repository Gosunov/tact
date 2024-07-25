import { CompilationOutput } from "../pipeline/compile";
import { getSortedTypes } from "../storage/resolveAllocation";
import { CompilerContext } from "../context";
import { idToHex } from "../utils/idToHex";
import { LocationContext, Location, locEquals, locValue } from ".";
import { WriterContext, ModuleGen, WrittenFunction } from ".";
import { getRawAST } from "../grammar/store";
import { ContractABI } from "@ton/core";
import { FuncFormatter } from "../func/formatter";
import { FuncAstModule, FuncAstComment } from "../func/syntax";
import { deepCopy } from "../func/syntaxUtils";
import {
    comment,
    mod,
    pragma,
    Type,
    include,
    global,
    toDeclaration,
    FunAttr,
} from "../func/syntaxConstructors";
import { calculateIPFSlink } from "../utils/calculateIPFSlink";

export type GeneratedFilesInfo = {
    files: { name: string; code: string }[];
    imported: string[];
};

/**
 * Func version used to compile the generated code.
 */
export const CODEGEN_FUNC_VERSION = "0.4.4";

/**
 * Generates Func files that correspond to the input Tact project.
 */
export class FuncGenerator {
    private tactCtx: CompilerContext;
    /** An ABI structure of the project generated by the Tact compiler. */
    private abiSrc: ContractABI;
    /** Basename used e.g. to name the generated Func files. */
    private basename: string;
    private funcCtx: WriterContext;

    private constructor(
        tactCtx: CompilerContext,
        abiSrc: ContractABI,
        basename: string,
    ) {
        this.tactCtx = tactCtx;
        this.abiSrc = abiSrc;
        this.basename = basename;
        this.funcCtx = new WriterContext(tactCtx);
    }

    static fromTactProject(
        tactCtx: CompilerContext,
        abiSrc: ContractABI,
        basename: string,
    ): FuncGenerator {
        return new FuncGenerator(tactCtx, abiSrc, basename);
    }

    /**
     * Translates the whole Tact project to Func.
     * @returns Information about generated Func files and their code.
     */
    public async writeProgram(): Promise<CompilationOutput> {
        const abi = JSON.stringify(this.abiSrc);
        const abiLink = await calculateIPFSlink(Buffer.from(abi));

        const m = ModuleGen.fromTact(
            this.funcCtx,
            this.abiSrc.name!,
            abiLink,
        ).writeAll();
        const functions = this.funcCtx.extract();

        //
        // Emit files
        //
        const generated: GeneratedFilesInfo = { files: [], imported: [] };

        //
        // Headers
        //
        this.generateHeaders(generated, functions);

        //
        // stdlib
        //
        this.generateStdlib(generated, functions);

        //
        // native
        //
        this.generateNative(generated);

        //
        // constants
        //
        this.generateConstants(generated, functions);

        //
        // storage
        //
        this.generateStorage(generated, functions);

        //
        // Remaining
        //
        // TODO

        // Finalize and dump the main contract, as we have just obtained the structure of the project
        m.entries.unshift(
            ...generated.files.map((f) => include(f.name)),
        );
        m.entries.unshift(
            ...[
                `version =${CODEGEN_FUNC_VERSION}`,
                "allow-post-modification",
                "compute-asm-ltr",
            ].map(pragma),
        );
        generated.files.push({
            name: `${this.basename}.code.fc`,
            code: new FuncFormatter().dump(m),
        });

        // header.push("");
        // header.push(";;");
        // header.push(`;; Contract ${abiSrc.name} functions`);
        // header.push(";;");
        // header.push("");
        // const code = emit({
        //     header: header.join("\n"),
        //     functions: remainingFunctions,
        // });
        // files.push({
        //     name: basename + ".code.fc",
        //     code,
        // });

        return {
            entrypoint: `${this.basename}.code.fc`,
            files: generated.files,
            abi,
        };
    }

    /**
     * Generates a file that contains declarations of all the generated Func functions.
     */
    private generateHeaders(
        generated: GeneratedFilesInfo,
        functions: WrittenFunction[],
    ): void {
        // FIXME: We should add only contract methods and special methods here => add attribute and register them in the context
        const m = mod();
        m.entries.push(
            comment(
                "",
                `Header files for ${this.abiSrc.name}`,
                "NOTE: declarations are sorted for optimal order",
                "",
            ),
        );
        functions.forEach((f) => {
            if (
                f.kind === "generic" &&
                f.definition.kind === "function_definition"
            ) {
                m.entries.push(
                    comment(f.definition.name.value, { skipCR: true }),
                );
                const copiedDefinition = deepCopy(f.definition);
                if (
                    copiedDefinition.attrs.find(
                        (attr) =>
                            attr.kind !== "impure" && attr.kind !== "inline",
                    )
                ) {
                    copiedDefinition.attrs.push(FunAttr.inline_ref());
                }
                m.entries.push(toDeclaration(copiedDefinition));
            }
        });
        generated.files.push({
            name: `${this.basename}.headers.fc`,
            code: new FuncFormatter().dump(m),
        });
    }

    private generateStdlib(
        generated: GeneratedFilesInfo,
        functions: WrittenFunction[],
    ): void {
        const m = mod();
        m.entries.push(
            global(
                Type.tensor(Type.int(), Type.slice(), Type.int(), Type.slice()),
                "__tact_context",
            ),
        );
        m.entries.push(global(Type.slice(), "__tact_context_sender"));
        m.entries.push(global(Type.cell(), "__tact_context_sys"));
        m.entries.push(global(Type.int(), "__tact_randomized"));

        const stdlibFunctions = this.tryExtractModule(
            functions,
            Location.stdlib(),
            [],
        );
        if (stdlibFunctions) {
            generated.imported.push("stdlib");
        }
        stdlibFunctions.forEach((f) => m.entries.push(f.definition));
        generated.files.push({
            name: `${this.basename}.stdlib.fc`,
            code: new FuncFormatter().dump(m),
        });
    }

    private generateNative(generated: GeneratedFilesInfo): void {
        const nativeSources = getRawAST(this.funcCtx.ctx).funcSources;
        if (nativeSources.length > 0) {
            generated.imported.push("native");
            generated.files.push({
                name: `${this.basename}.native.fc`,
                code: [...nativeSources.map((v) => v.code)].join("\n\n"),
            });
        }
    }

    private generateConstants(
        generated: GeneratedFilesInfo,
        functions: WrittenFunction[],
    ): void {
        const constantsFunctions = this.tryExtractModule(
            functions,
            Location.constants(),
            generated.imported,
        );
        if (constantsFunctions) {
            generated.imported.push("constants");
            generated.files.push({
                name: `${this.basename}.constants.fc`,
                code: new FuncFormatter().dump(
                    mod(...constantsFunctions.map((v) => v.definition)),
                ),
            });
        }
    }

    private generateStorage(
        generated: GeneratedFilesInfo,
        functions: WrittenFunction[],
    ): void {
        const generatedModules: FuncAstModule[] = [];
        const types = getSortedTypes(this.funcCtx.ctx);
        for (const t of types) {
            const ffs: WrittenFunction[] = [];
            if (
                t.kind === "struct" ||
                t.kind === "contract" ||
                t.kind == "trait"
            ) {
                const typeFunctions = this.tryExtractModule(
                    functions,
                    Location.type(t.name),
                    generated.imported,
                );
                if (typeFunctions) {
                    generated.imported.push(`type:${t.name}`);
                    ffs.push(...typeFunctions);
                }
            }
            if (t.kind === "contract") {
                const typeFunctions = this.tryExtractModule(
                    functions,
                    Location.type(`${t.name}$init`),
                    generated.imported,
                );
                if (typeFunctions) {
                    generated.imported.push("type:" + t.name + "$init");
                    ffs.push(...typeFunctions);
                }
            }
            const comments: string[] = [];
            if (ffs.length > 0) {
                comments.push("");
                comments.push(`Type: ${t.name}`);
                if (t.header !== null) {
                    comments.push(`Header: 0x${idToHex(t.header)}`);
                }
                if (t.tlb) {
                    comments.push(`TLB: ${t.tlb}`);
                }
                comments.push("");
            }
            generatedModules.push(
                mod(...[comment(...comments), ...ffs.map((f) => f.definition)]),
            );
        }
        if (generatedModules.length > 0) {
            generated.files.push({
                name: `${this.basename}.storage.fc`,
                code: generatedModules
                    .map((m) => new FuncFormatter().dump(m))
                    .join("\n\n"),
            });
        }
    }

    private tryExtractModule(
        functions: WrittenFunction[],
        location: LocationContext,
        imported: string[],
    ): WrittenFunction[] {
        // Put to map
        const maps: Map<string, WrittenFunction> = new Map();
        for (const f of functions) {
            maps.set(f.name, f);
        }

        // Extract functions of a context
        const ctxFunctions: WrittenFunction[] = functions
            .filter((v) => v.kind !== "skip")
            .filter((v) => {
                if (location !== undefined && v.context !== undefined) {
                    return locEquals(v.context, location);
                } else {
                    return (
                        v.context === undefined ||
                        !imported.includes(locValue(v.context))
                    );
                }
            });
        if (ctxFunctions.length === 0) {
            return [];
        }

        return ctxFunctions;
    }
}
