CREATE TABLE "comment_audio" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"section" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"transcription" text DEFAULT 'none' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_audio" ADD CONSTRAINT "comment_audio_comment_id_content_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."content_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_comments" ADD CONSTRAINT "content_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_comments" ADD CONSTRAINT "content_comments_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_comments_content" ON "content_comments" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "content_comments_ws" ON "content_comments" USING btree ("workspace_id");