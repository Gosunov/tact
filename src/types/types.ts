import type { ABIField } from "@ton/core";
import { throwInternalCompilerError } from "../error/errors";
import type * as Ast from "../ast/ast";
import type { SrcInfo } from "../grammar";
import { idText } from "../ast/ast-helpers";
import type { ItemOrigin } from "../imports/source";
import type { Effect } from "./effects";

export type TypeDescription = {
    kind: "struct" | "primitive_type_decl" | "contract" | "trait";
    origin: ItemOrigin;
    name: string;
    uid: number;
    header: Ast.Number | null;
    tlb: string | null;
    signature: string | null;
    fields: FieldDescription[];
    partialFieldCount: number; // Max number of fields that can be parsed when message is bounced
    traits: TypeDescription[];
    functions: Map<string, FunctionDescription>;
    receivers: ReceiverDescription[];
    init: InitDescription | null;
    ast: Ast.TypeDecl;
    dependsOn: TypeDescription[];
    interfaces: string[];
    constants: ConstantDescription[];
};

export type TypeRef =
    | {
          kind: "ref";
          name: string;
          optional: boolean;
      }
    | {
          kind: "map";
          key: string;
          keyAs: string | null;
          value: string;
          valueAs: string | null;
      }
    | {
          kind: "ref_bounced";
          name: string;
      }
    | {
          kind: "void";
      }
    | {
          kind: "null";
      };

// https://github.com/microsoft/TypeScript/issues/35164 and
// https://github.com/microsoft/TypeScript/pull/57293
// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style

export function showValue(val: Ast.Literal): string {
    switch (val.kind) {
        case "number":
            return val.value.toString(val.base);
        case "simplified_string":
            return val.value;
        case "boolean":
            return val.value ? "true" : "false";
        case "address":
            return val.value.toRawString();
        case "cell":
        case "slice":
            return val.value.toString();
        case "null":
            return "null";
        case "struct_value": {
            const assocList = val.args.map(
                (field) =>
                    `${idText(field.field)}: ${showValue(field.initializer)}`,
            );
            return `{${assocList.join(",")}}`;
        }
        default:
            throwInternalCompilerError("Invalid value");
    }
}

export type FieldDescription = {
    name: string;
    index: number;
    type: TypeRef;
    as: string | null;
    default: Ast.Literal | undefined;
    loc: SrcInfo;
    ast: Ast.FieldDecl;
    abi: ABIField;
};

export type ConstantDescription = {
    name: string;
    type: TypeRef;
    value: Ast.Literal | undefined;
    loc: SrcInfo;
    ast: Ast.ConstantDef | Ast.ConstantDecl;
};

export type FunctionParameter = {
    name: Ast.Id;
    type: TypeRef;
    loc: SrcInfo;
};

export type FunctionDescription = {
    name: string;
    origin: ItemOrigin;
    isGetter: boolean;
    methodId: number | null;
    isMutating: boolean;
    isOverride: boolean;
    isVirtual: boolean;
    isAbstract: boolean;
    isInline: boolean;
    self: TypeRef | null;
    returns: TypeRef;
    params: FunctionParameter[];
    ast:
        | Ast.FunctionDef
        | Ast.NativeFunctionDecl
        | Ast.FunctionDecl
        | Ast.AsmFunctionDef;
};

export type BinaryReceiverSelector =
    | {
          kind: "internal-binary";
          type: string;
          name: Ast.Id;
      }
    | {
          kind: "bounce-binary";
          name: Ast.Id;
          type: string;
          bounced: boolean;
      }
    | {
          kind: "external-binary";
          type: string;
          name: Ast.Id;
      };

export type CommentReceiverSelector =
    | {
          kind: "internal-comment";
          comment: string;
      }
    | {
          kind: "external-comment";
          comment: string;
      };

type EmptyReceiverSelector =
    | {
          kind: "internal-empty";
      }
    | {
          kind: "external-empty";
      };

export type FallbackReceiverSelector =
    | {
          kind: "internal-comment-fallback";
          name: Ast.Id;
      }
    | {
          kind: "internal-fallback";
          name: Ast.Id;
      }
    | {
          kind: "bounce-fallback";
          name: Ast.Id;
      }
    | {
          kind: "external-comment-fallback";
          name: Ast.Id;
      }
    | {
          kind: "external-fallback";
          name: Ast.Id;
      };

export type ReceiverSelector =
    | BinaryReceiverSelector
    | CommentReceiverSelector
    | EmptyReceiverSelector
    | FallbackReceiverSelector;

// TODO: improve this for empty and fallbacks
export function receiverSelectorName(selector: ReceiverSelector): string {
    switch (selector.kind) {
        case "internal-binary":
        case "bounce-binary":
        case "external-binary":
            return selector.type;
        case "internal-comment":
        case "external-comment":
            return selector.comment;
        case "internal-empty":
        case "external-empty":
            return selector.kind;
        case "internal-fallback":
        case "bounce-fallback":
        case "external-fallback":
            return selector.kind;
        case "internal-comment-fallback":
        case "external-comment-fallback":
            return selector.kind;
    }
}

export type ReceiverDescription = {
    selector: ReceiverSelector;
    ast: Ast.Receiver;
    effects: ReadonlySet<Effect>;
};

export type InitParameter = {
    name: Ast.Id;
    type: TypeRef;
    as: string | null;
    loc: SrcInfo;
};

export type InitDescription = SeparateInitDescription | ContractInitDescription;

type SeparateInitDescription = {
    kind: "init-function";
    params: InitParameter[];
    ast: Ast.ContractInit;
};

type ContractInitDescription = {
    kind: "contract-params";
    params: InitParameter[];
    ast: Ast.ContractInit;
    contract: Ast.Contract;
};

export function printTypeRef(src: TypeRef): string {
    switch (src.kind) {
        case "ref":
            return `${src.name}${src.optional ? "?" : ""}`;
        case "map":
            return `map<${src.key + (src.keyAs ? " as " + src.keyAs : "")}, ${src.value + (src.valueAs ? " as " + src.valueAs : "")}>`;
        case "void":
            return "<void>";
        case "null":
            return "<null>";
        case "ref_bounced":
            return `bounced<${src.name}>`;
    }
}

export function typeRefEquals(a: TypeRef, b: TypeRef) {
    if (a.kind !== b.kind) {
        return false;
    }
    if (a.kind === "ref" && b.kind === "ref") {
        return a.name === b.name && a.optional === b.optional;
    }
    if (a.kind === "map" && b.kind === "map") {
        return a.key === b.key && a.value === b.value;
    }
    if (a.kind === "ref_bounced" && b.kind === "ref_bounced") {
        return a.name === b.name;
    }
    if (a.kind === "null" && b.kind === "null") {
        return true;
    }
    if (a.kind === "void" && b.kind === "void") {
        return true;
    }
    return false;
}
