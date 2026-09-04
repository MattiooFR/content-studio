CREATE TABLE "dictation_audio" (
	"dictation_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dictations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"error" text,
	"field_key" text DEFAULT '' NOT NULL,
	"consumed_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dictation_audio" ADD CONSTRAINT "dictation_audio_dictation_id_dictations_id_fk" FOREIGN KEY ("dictation_id") REFERENCES "public"."dictations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dictations" ADD CONSTRAINT "dictations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dictations_ws_status" ON "dictations" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "dictations_ws_field" ON "dictations" USING btree ("workspace_id","field_key");