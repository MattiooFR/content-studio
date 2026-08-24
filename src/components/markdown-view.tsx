"use client";
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

// Vue lecture d'un markdown : même pile que l'éditeur et la relecture
// (StarterKit + tiptap-markdown), donc mêmes styles .ProseMirror — sans
// édition ni sauvegarde.
export function MarkdownView({ markdown, className }: { markdown: string; className?: string }) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: markdown, editable: false, immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(markdown, { emitUpdate: false });
  }, [editor, markdown]);

  return <EditorContent editor={editor} className={className} />;
}
