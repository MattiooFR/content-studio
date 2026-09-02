CREATE TABLE "watch_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "watch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"author" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text_source" text NOT NULL,
	"lang" text,
	"posted_at" timestamp,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visual" jsonb,
	"text_adapted" text,
	"score" double precision,
	"status" text NOT NULL,
	"refusal_reason" text,
	"refusal_note" text,
	"publish_ref" jsonb,
	"idea_id" uuid,
	"content_id" uuid,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "watch_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"style" text DEFAULT '' NOT NULL,
	"require_media" boolean DEFAULT false NOT NULL,
	"channel_key" text,
	"publish_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watch_feeds" ADD CONSTRAINT "watch_feeds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_items" ADD CONSTRAINT "watch_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_items" ADD CONSTRAINT "watch_items_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_items" ADD CONSTRAINT "watch_items_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_settings" ADD CONSTRAINT "watch_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_feeds_ws_kind_label" ON "watch_feeds" USING btree ("workspace_id","kind","label");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_items_ws_external" ON "watch_items" USING btree ("workspace_id","external_id");--> statement-breakpoint
CREATE INDEX "watch_items_ws_status_score" ON "watch_items" USING btree ("workspace_id","status","score");--> statement-breakpoint
CREATE INDEX "watch_items_ws_status_fetched" ON "watch_items" USING btree ("workspace_id","status","fetched_at");