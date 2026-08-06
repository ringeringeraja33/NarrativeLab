// Type declarations for markdown-it plugins without official TypeScript definitions
declare module 'markdown-it-emoji';
declare module 'markdown-it-mark';

// Allow importing .md files as raw text strings (esbuild text loader)
declare module '*.md' {
    const content: string;
    export default content;
}

// Ambient declarations for externalized CodeMirror / Lezer packages
declare module '@codemirror/language' {
    import type { EditorState } from '@codemirror/state';
    export interface SyntaxNode { name: string; from: number; to: number; }
    export function syntaxTree(state: EditorState): { iterate(spec: { enter(node: SyntaxNode): void | false }): void };
}

declare module '@codemirror/commands';
