CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idea_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"raw_excerpt" text DEFAULT '' NOT NULL,
	"extracted_text" text DEFAULT '' NOT NULL,
	"extracted_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sources_ws" ON "sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sources_idea" ON "sources" USING btree ("idea_id");