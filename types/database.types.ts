export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_provider_keys: {
        Row: {
          created_at: string
          encrypted_api_key: string
          id: string
          key_preview: string
          model: string | null
          organization_id: string
          provider: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          encrypted_api_key: string
          id?: string
          key_preview: string
          model?: string | null
          organization_id: string
          provider: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          encrypted_api_key?: string
          id?: string
          key_preview?: string
          model?: string | null
          organization_id?: string
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_recommendations: {
        Row: {
          created_at: string
          entity_id: string | null
          entity_type: string
          error_message: string | null
          generated_by: string | null
          id: string
          input_snapshot: Json
          model: string
          organization_id: string
          provider: string
          recommendation_text: string | null
          status: string
        }
        Insert: {
          created_at?: string
          entity_id?: string | null
          entity_type: string
          error_message?: string | null
          generated_by?: string | null
          id?: string
          input_snapshot: Json
          model: string
          organization_id: string
          provider: string
          recommendation_text?: string | null
          status: string
        }
        Update: {
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          error_message?: string | null
          generated_by?: string | null
          id?: string
          input_snapshot?: Json
          model?: string
          organization_id?: string
          provider?: string
          recommendation_text?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_recommendations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_daily_rollups: {
        Row: {
          created_at: string
          event_count: number
          event_type: string
          id: string
          organization_id: string
          rollup_date: string
          subject_id: string
          subject_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          event_count?: number
          event_type: string
          id?: string
          organization_id: string
          rollup_date: string
          subject_id: string
          subject_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          event_count?: number
          event_type?: string
          id?: string
          organization_id?: string
          rollup_date?: string
          subject_id?: string
          subject_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytics_daily_rollups_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string
          subject_id: string | null
          subject_type: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id: string
          subject_id?: string | null
          subject_type?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string
          subject_id?: string | null
          subject_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          error: string | null
          id: string
          job_type: string
          organization_id: string
          started_at: string | null
          status: string
          target_date: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          job_type: string
          organization_id: string
          started_at?: string | null
          status?: string
          target_date: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error?: string | null
          id?: string
          job_type?: string
          organization_id?: string
          started_at?: string | null
          status?: string
          target_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytics_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_snapshots: {
        Row: {
          created_at: string
          id: string
          metrics: Json
          organization_id: string
          snapshot_date: string
        }
        Insert: {
          created_at?: string
          id?: string
          metrics?: Json
          organization_id: string
          snapshot_date: string
        }
        Update: {
          created_at?: string
          id?: string
          metrics?: Json
          organization_id?: string
          snapshot_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytics_snapshots_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          metadata: Json
          organization_id: string
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id: string
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_customers: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          stripe_customer_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          stripe_customer_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          stripe_customer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_customers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_checkouts: {
        Row: {
          billing_interval: string
          claim_token_hash: string | null
          created_at: string
          currency: string
          expires_at: string
          id: string
          internal_plan_id: string
          organization_id: string
          provider: string
          provider_subscription_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          billing_interval: string
          claim_token_hash?: string | null
          created_at?: string
          currency: string
          expires_at: string
          id?: string
          internal_plan_id: string
          organization_id: string
          provider: string
          provider_subscription_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          billing_interval?: string
          claim_token_hash?: string | null
          created_at?: string
          currency?: string
          expires_at?: string
          id?: string
          internal_plan_id?: string
          organization_id?: string
          provider?: string
          provider_subscription_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_checkouts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_customers_v2: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          provider: string
          provider_customer_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          provider: string
          provider_customer_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          provider?: string
          provider_customer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_customers_v2_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_leads: {
        Row: {
          campaign_id: string
          created_at: string
          current_step_id: string | null
          enrolled_at: string
          id: string
          last_error: string | null
          lead_id: string
          locked_until: string | null
          mailbox_id: string | null
          next_send_at: string | null
          send_now_step_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          current_step_id?: string | null
          enrolled_at?: string
          id?: string
          last_error?: string | null
          lead_id: string
          locked_until?: string | null
          mailbox_id?: string | null
          next_send_at?: string | null
          send_now_step_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          current_step_id?: string | null
          enrolled_at?: string
          id?: string
          last_error?: string | null
          lead_id?: string
          locked_until?: string | null
          mailbox_id?: string | null
          next_send_at?: string | null
          send_now_step_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_current_step_id_fkey"
            columns: ["current_step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_leads_send_now_step_id_fkey"
            columns: ["send_now_step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_mailboxes: {
        Row: {
          campaign_id: string
          created_at: string
          id: string
          mailbox_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          id?: string
          mailbox_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          id?: string
          mailbox_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_mailboxes_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_mailboxes_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          created_at: string
          daily_limit: number
          default_mailbox_id: string | null
          id: string
          name: string
          sending_window: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          daily_limit?: number
          default_mailbox_id?: string | null
          id?: string
          name: string
          sending_window?: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          daily_limit?: number
          default_mailbox_id?: string | null
          id?: string
          name?: string
          sending_window?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_default_mailbox_id_fkey"
            columns: ["default_mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      domain_dns_checks: {
        Row: {
          checked_at: string
          created_at: string
          detail: string | null
          domain_id: string
          id: string
          record_type: string
          status: string
          user_id: string
        }
        Insert: {
          checked_at?: string
          created_at?: string
          detail?: string | null
          domain_id: string
          id?: string
          record_type: string
          status?: string
          user_id: string
        }
        Update: {
          checked_at?: string
          created_at?: string
          detail?: string | null
          domain_id?: string
          id?: string
          record_type?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "domain_dns_checks_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
        ]
      }
      domains: {
        Row: {
          created_at: string
          dkim_verified: boolean
          dmarc_verified: boolean
          domain: string
          health_score: number
          id: string
          last_checked_at: string | null
          mx_verified: boolean
          spf_verified: boolean
          status: string
          tracking_domain: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          dkim_verified?: boolean
          dmarc_verified?: boolean
          domain: string
          health_score?: number
          id?: string
          last_checked_at?: string | null
          mx_verified?: boolean
          spf_verified?: boolean
          status?: string
          tracking_domain?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          dkim_verified?: boolean
          dmarc_verified?: boolean
          domain?: string
          health_score?: number
          id?: string
          last_checked_at?: string | null
          mx_verified?: boolean
          spf_verified?: boolean
          status?: string
          tracking_domain?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      email_attachments: {
        Row: {
          created_at: string
          file_name: string
          id: string
          mime_type: string
          sequence_step_id: string | null
          size_bytes: number
          storage_path: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          mime_type: string
          sequence_step_id?: string | null
          size_bytes: number
          storage_path: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          mime_type?: string
          sequence_step_id?: string | null
          size_bytes?: number
          storage_path?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_attachments_sequence_step_id_fkey"
            columns: ["sequence_step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      email_events: {
        Row: {
          campaign_id: string
          created_at: string
          event_type: string
          id: string
          lead_id: string
          mailbox_id: string | null
          metadata: Json
          provider_message_id: string | null
          updated_at: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          event_type: string
          id?: string
          lead_id: string
          mailbox_id?: string | null
          metadata?: Json
          provider_message_id?: string | null
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          event_type?: string
          id?: string
          lead_id?: string
          mailbox_id?: string | null
          metadata?: Json
          provider_message_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_events_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_events_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_events_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      email_replies: {
        Row: {
          body_html: string | null
          body_text: string | null
          campaign_id: string
          created_at: string
          email_event_id: string
          from_email: string
          from_name: string | null
          id: string
          lead_id: string
          mailbox_id: string
          read_at: string | null
          received_at: string
          subject: string | null
          to_emails: string[]
        }
        Insert: {
          body_html?: string | null
          body_text?: string | null
          campaign_id: string
          created_at?: string
          email_event_id: string
          from_email: string
          from_name?: string | null
          id?: string
          lead_id: string
          mailbox_id: string
          read_at?: string | null
          received_at: string
          subject?: string | null
          to_emails?: string[]
        }
        Update: {
          body_html?: string | null
          body_text?: string | null
          campaign_id?: string
          created_at?: string
          email_event_id?: string
          from_email?: string
          from_name?: string | null
          id?: string
          lead_id?: string
          mailbox_id?: string
          read_at?: string | null
          received_at?: string
          subject?: string | null
          to_emails?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "email_replies_email_event_id_fkey"
            columns: ["email_event_id"]
            isOneToOne: true
            referencedRelation: "email_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_replies_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_replies_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_replies_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_usage: {
        Row: {
          created_at: string
          id: string
          month: string
          sent_count: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          month: string
          sent_count?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          month?: string
          sent_count?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          config: Json
          created_at: string
          id: string
          last_error: string | null
          last_sent_at: string | null
          last_status: string | null
          organization_id: string
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          last_error?: string | null
          last_sent_at?: string | null
          last_status?: string | null
          organization_id: string
          provider: string
          status?: string
          updated_at?: string
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          last_error?: string | null
          last_sent_at?: string | null
          last_status?: string | null
          organization_id?: string
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_runs: {
        Row: {
          created_at: string
          duration_ms: number
          error: string | null
          id: string
          job: string
          started_at: string
          status: string
          summary: Json
        }
        Insert: {
          created_at?: string
          duration_ms: number
          error?: string | null
          id?: string
          job: string
          started_at: string
          status: string
          summary?: Json
        }
        Update: {
          created_at?: string
          duration_ms?: number
          error?: string | null
          id?: string
          job?: string
          started_at?: string
          status?: string
          summary?: Json
        }
        Relationships: []
      }
      lead_lists: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      lead_segments: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          rules: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          rules: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          rules?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          city: string | null
          company: string | null
          country: string | null
          created_at: string
          custom_fields: Json
          email: string
          first_name: string | null
          id: string
          last_name: string | null
          linkedin: string | null
          list_id: string | null
          phone: string | null
          status: string
          timezone: string | null
          title: string | null
          updated_at: string
          user_id: string
          verification_detail: Json | null
          verification_locked_until: string | null
          verification_risk_score: number | null
          verification_status: string
          verified_at: string | null
          website: string | null
        }
        Insert: {
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          custom_fields?: Json
          email: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin?: string | null
          list_id?: string | null
          phone?: string | null
          status?: string
          timezone?: string | null
          title?: string | null
          updated_at?: string
          user_id: string
          verification_detail?: Json | null
          verification_locked_until?: string | null
          verification_risk_score?: number | null
          verification_status?: string
          verified_at?: string | null
          website?: string | null
        }
        Update: {
          city?: string | null
          company?: string | null
          country?: string | null
          created_at?: string
          custom_fields?: Json
          email?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin?: string | null
          list_id?: string | null
          phone?: string | null
          status?: string
          timezone?: string | null
          title?: string | null
          updated_at?: string
          user_id?: string
          verification_detail?: Json | null
          verification_locked_until?: string | null
          verification_risk_score?: number | null
          verification_status?: string
          verified_at?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lead_lists"
            referencedColumns: ["id"]
          },
        ]
      }
      mailbox_health: {
        Row: {
          bounce_rate: number | null
          created_at: string
          health_score: number
          id: string
          last_calculated_at: string | null
          mailbox_id: string
          reply_rate: number | null
          reputation_score: number | null
          updated_at: string
          user_id: string
          warmup_status: string
        }
        Insert: {
          bounce_rate?: number | null
          created_at?: string
          health_score?: number
          id?: string
          last_calculated_at?: string | null
          mailbox_id: string
          reply_rate?: number | null
          reputation_score?: number | null
          updated_at?: string
          user_id: string
          warmup_status?: string
        }
        Update: {
          bounce_rate?: number | null
          created_at?: string
          health_score?: number
          id?: string
          last_calculated_at?: string | null
          mailbox_id?: string
          reply_rate?: number | null
          reputation_score?: number | null
          updated_at?: string
          user_id?: string
          warmup_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "mailbox_health_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: true
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      mailboxes: {
        Row: {
          cooldown_minutes: number
          created_at: string
          daily_limit: number
          display_name: string | null
          domain_id: string | null
          email: string
          email_provider: string
          encrypted_google_refresh_token: string | null
          encrypted_imap_password: string | null
          encrypted_microsoft_refresh_token: string | null
          encrypted_smtp_password: string | null
          hourly_limit: number
          id: string
          imap_enabled: boolean
          imap_host: string | null
          imap_last_uid: number | null
          imap_port: number
          imap_uid_validity: number | null
          imap_username: string | null
          reply_provider: string
          reply_sync_claimed_at: string | null
          reply_sync_locked_until: string | null
          smtp_host: string
          smtp_port: number
          smtp_username: string
          status: string
          updated_at: string
          user_id: string
          warmup_enabled: boolean
        }
        Insert: {
          cooldown_minutes?: number
          created_at?: string
          daily_limit?: number
          display_name?: string | null
          domain_id?: string | null
          email: string
          email_provider?: string
          encrypted_google_refresh_token?: string | null
          encrypted_imap_password?: string | null
          encrypted_microsoft_refresh_token?: string | null
          encrypted_smtp_password?: string | null
          hourly_limit?: number
          id?: string
          imap_enabled?: boolean
          imap_host?: string | null
          imap_last_uid?: number | null
          imap_port?: number
          imap_uid_validity?: number | null
          imap_username?: string | null
          reply_provider?: string
          reply_sync_claimed_at?: string | null
          reply_sync_locked_until?: string | null
          smtp_host: string
          smtp_port?: number
          smtp_username: string
          status?: string
          updated_at?: string
          user_id: string
          warmup_enabled?: boolean
        }
        Update: {
          cooldown_minutes?: number
          created_at?: string
          daily_limit?: number
          display_name?: string | null
          domain_id?: string | null
          email?: string
          email_provider?: string
          encrypted_google_refresh_token?: string | null
          encrypted_imap_password?: string | null
          encrypted_microsoft_refresh_token?: string | null
          encrypted_smtp_password?: string | null
          hourly_limit?: number
          id?: string
          imap_enabled?: boolean
          imap_host?: string | null
          imap_last_uid?: number | null
          imap_port?: number
          imap_uid_validity?: number | null
          imap_username?: string | null
          reply_provider?: string
          reply_sync_claimed_at?: string | null
          reply_sync_locked_until?: string | null
          smtp_host?: string
          smtp_port?: number
          smtp_username?: string
          status?: string
          updated_at?: string
          user_id?: string
          warmup_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "mailboxes_domain_id_fkey"
            columns: ["domain_id"]
            isOneToOne: false
            referencedRelation: "domains"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_user_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_webhook_events: {
        Row: {
          event_id: string
          event_type: string
          processed_at: string
          provider: string
        }
        Insert: {
          event_id: string
          event_type: string
          processed_at?: string
          provider: string
        }
        Update: {
          event_id?: string
          event_type?: string
          processed_at?: string
          provider?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          timezone: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          timezone?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          timezone?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      rate_limit_events: {
        Row: {
          created_at: string
          id: string
          identity: string
          scope: string
        }
        Insert: {
          created_at?: string
          id?: string
          identity: string
          scope: string
        }
        Update: {
          created_at?: string
          id?: string
          identity?: string
          scope?: string
        }
        Relationships: []
      }
      send_attempts: {
        Row: {
          attempt_count: number
          campaign_lead_id: string
          claimed_at: string
          created_at: string
          id: string
          last_error: string | null
          provider_message_id: string | null
          resolved_at: string | null
          resolved_manually: boolean
          sequence_step_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          campaign_lead_id: string
          claimed_at?: string
          created_at?: string
          id?: string
          last_error?: string | null
          provider_message_id?: string | null
          resolved_at?: string | null
          resolved_manually?: boolean
          sequence_step_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          campaign_lead_id?: string
          claimed_at?: string
          created_at?: string
          id?: string
          last_error?: string | null
          provider_message_id?: string | null
          resolved_at?: string | null
          resolved_manually?: boolean
          sequence_step_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "send_attempts_campaign_lead_id_fkey"
            columns: ["campaign_lead_id"]
            isOneToOne: false
            referencedRelation: "campaign_leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "send_attempts_sequence_step_id_fkey"
            columns: ["sequence_step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_steps: {
        Row: {
          body: string | null
          created_at: string
          day_delay: number
          id: string
          sequence_id: string
          step_order: number
          subject: string | null
          updated_at: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          day_delay?: number
          id?: string
          sequence_id: string
          step_order: number
          subject?: string | null
          updated_at?: string
        }
        Update: {
          body?: string | null
          created_at?: string
          day_delay?: number
          id?: string
          sequence_id?: string
          step_order?: number
          subject?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequence_steps_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      sequences: {
        Row: {
          campaign_id: string
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sequences_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          created_at: string
          id: string
          signature: string | null
          timezone: string
          tracking_enabled: boolean
          unsubscribe_text: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          signature?: string | null
          timezone?: string
          tracking_enabled?: boolean
          unsubscribe_text?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          signature?: string | null
          timezone?: string
          tracking_enabled?: boolean
          unsubscribe_text?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          created_at: string
          id: string
          type: string
        }
        Insert: {
          created_at?: string
          id: string
          type: string
        }
        Update: {
          created_at?: string
          id?: string
          type?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: string
          organization_id: string
          status: string
          stripe_price_id: string
          stripe_subscription_id: string
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          organization_id: string
          status: string
          stripe_price_id: string
          stripe_subscription_id: string
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          organization_id?: string
          status?: string
          stripe_price_id?: string
          stripe_subscription_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions_v2: {
        Row: {
          billing_interval: string
          cancel_at_period_end: boolean
          created_at: string
          currency: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          internal_plan_id: string
          normalized_status: string
          organization_id: string
          provider: string
          provider_plan_id: string
          provider_status: string
          provider_subscription_id: string
          updated_at: string
        }
        Insert: {
          billing_interval: string
          cancel_at_period_end?: boolean
          created_at?: string
          currency?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          internal_plan_id: string
          normalized_status: string
          organization_id: string
          provider: string
          provider_plan_id: string
          provider_status: string
          provider_subscription_id: string
          updated_at?: string
        }
        Update: {
          billing_interval?: string
          cancel_at_period_end?: boolean
          created_at?: string
          currency?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          internal_plan_id?: string
          normalized_status?: string
          organization_id?: string
          provider?: string
          provider_plan_id?: string
          provider_status?: string
          provider_subscription_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_v2_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      suppressions: {
        Row: {
          created_at: string
          email: string
          id: string
          reason: string
          source_campaign_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          reason: string
          source_campaign_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          reason?: string
          source_campaign_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppressions_source_campaign_id_fkey"
            columns: ["source_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          body: string | null
          created_at: string
          id: string
          name: string
          subject: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          name: string
          subject?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          name?: string
          subject?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      verification_provider_keys: {
        Row: {
          created_at: string
          encrypted_api_key: string
          id: string
          key_preview: string
          organization_id: string
          provider: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          encrypted_api_key: string
          id?: string
          key_preview: string
          organization_id: string
          provider: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          encrypted_api_key?: string
          id?: string
          key_preview?: string
          organization_id?: string
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_provider_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_events: {
        Row: {
          created_at: string
          detail: string | null
          event_type: string
          id: string
          organization_id: string
          warmup_profile_id: string
        }
        Insert: {
          created_at?: string
          detail?: string | null
          event_type: string
          id?: string
          organization_id: string
          warmup_profile_id: string
        }
        Update: {
          created_at?: string
          detail?: string | null
          event_type?: string
          id?: string
          organization_id?: string
          warmup_profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "warmup_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_events_warmup_profile_id_fkey"
            columns: ["warmup_profile_id"]
            isOneToOne: false
            referencedRelation: "warmup_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_messages: {
        Row: {
          created_at: string
          from_mailbox_id: string
          from_warmup_profile_id: string
          id: string
          in_reply_to: string | null
          message_type: string
          organization_id: string
          provider_message_id: string
          replied_at: string | null
          reply_decision: string
          reply_due_at: string | null
          sent_at: string
          status: string
          subject: string
          to_mailbox_id: string
        }
        Insert: {
          created_at?: string
          from_mailbox_id: string
          from_warmup_profile_id: string
          id?: string
          in_reply_to?: string | null
          message_type: string
          organization_id: string
          provider_message_id: string
          replied_at?: string | null
          reply_decision?: string
          reply_due_at?: string | null
          sent_at?: string
          status?: string
          subject: string
          to_mailbox_id: string
        }
        Update: {
          created_at?: string
          from_mailbox_id?: string
          from_warmup_profile_id?: string
          id?: string
          in_reply_to?: string | null
          message_type?: string
          organization_id?: string
          provider_message_id?: string
          replied_at?: string | null
          reply_decision?: string
          reply_due_at?: string | null
          sent_at?: string
          status?: string
          subject?: string
          to_mailbox_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "warmup_messages_from_mailbox_id_fkey"
            columns: ["from_mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_messages_from_warmup_profile_id_fkey"
            columns: ["from_warmup_profile_id"]
            isOneToOne: false
            referencedRelation: "warmup_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_messages_to_mailbox_id_fkey"
            columns: ["to_mailbox_id"]
            isOneToOne: false
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_profiles: {
        Row: {
          consecutive_failures: number
          created_at: string
          current_daily_volume: number
          health_score: number
          id: string
          imap_last_uid: number | null
          imap_uid_validity: number | null
          last_activity_at: string | null
          last_ramp_increase_at: string | null
          locked_until: string | null
          mailbox_id: string
          next_send_at: string | null
          organization_id: string
          ramp_up_percent: number
          stage: string
          started_at: string | null
          status: string
          target_daily_volume: number
          updated_at: string
        }
        Insert: {
          consecutive_failures?: number
          created_at?: string
          current_daily_volume?: number
          health_score?: number
          id?: string
          imap_last_uid?: number | null
          imap_uid_validity?: number | null
          last_activity_at?: string | null
          last_ramp_increase_at?: string | null
          locked_until?: string | null
          mailbox_id: string
          next_send_at?: string | null
          organization_id: string
          ramp_up_percent?: number
          stage?: string
          started_at?: string | null
          status?: string
          target_daily_volume?: number
          updated_at?: string
        }
        Update: {
          consecutive_failures?: number
          created_at?: string
          current_daily_volume?: number
          health_score?: number
          id?: string
          imap_last_uid?: number | null
          imap_uid_validity?: number | null
          last_activity_at?: string | null
          last_ramp_increase_at?: string | null
          locked_until?: string | null
          mailbox_id?: string
          next_send_at?: string | null
          organization_id?: string
          ramp_up_percent?: number
          stage?: string
          started_at?: string | null
          status?: string
          target_daily_volume?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "warmup_profiles_mailbox_id_fkey"
            columns: ["mailbox_id"]
            isOneToOne: true
            referencedRelation: "mailboxes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_stats: {
        Row: {
          bounce_rate: number | null
          created_at: string
          emails_received: number
          emails_sent: number
          id: string
          organization_id: string
          positive_interactions: number
          reply_rate: number | null
          spam_rate: number | null
          stat_date: string
          updated_at: string
          warmup_profile_id: string
          warmup_score: number | null
        }
        Insert: {
          bounce_rate?: number | null
          created_at?: string
          emails_received?: number
          emails_sent?: number
          id?: string
          organization_id: string
          positive_interactions?: number
          reply_rate?: number | null
          spam_rate?: number | null
          stat_date: string
          updated_at?: string
          warmup_profile_id: string
          warmup_score?: number | null
        }
        Update: {
          bounce_rate?: number | null
          created_at?: string
          emails_received?: number
          emails_sent?: number
          id?: string
          organization_id?: string
          positive_interactions?: number
          reply_rate?: number | null
          spam_rate?: number | null
          stat_date?: string
          updated_at?: string
          warmup_profile_id?: string
          warmup_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "warmup_stats_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_stats_warmup_profile_id_fkey"
            columns: ["warmup_profile_id"]
            isOneToOne: false
            referencedRelation: "warmup_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      attach_billing_checkout_subscription: {
        Args: {
          p_checkout_id: string
          p_claim_token: string
          p_provider_subscription_id: string
        }
        Returns: boolean
      }
      claim_billing_checkout: {
        Args: {
          p_billing_interval: string
          p_currency: string
          p_internal_plan_id: string
          p_organization_id: string
        }
        Returns: {
          checkout_id: string
          checkout_subscription_id: string
          claim_outcome: string
          claim_token: string
        }[]
      }
      claim_due_sends: {
        Args: { p_limit?: number }
        Returns: {
          campaign_id: string
          created_at: string
          current_step_id: string | null
          enrolled_at: string
          id: string
          last_error: string | null
          lead_id: string
          locked_until: string | null
          mailbox_id: string | null
          next_send_at: string | null
          send_now_step_id: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "campaign_leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_due_verifications: {
        Args: { p_limit?: number }
        Returns: {
          city: string | null
          company: string | null
          country: string | null
          created_at: string
          custom_fields: Json
          email: string
          first_name: string | null
          id: string
          last_name: string | null
          linkedin: string | null
          list_id: string | null
          phone: string | null
          status: string
          title: string | null
          updated_at: string
          user_id: string
          verification_detail: Json | null
          verification_locked_until: string | null
          verification_risk_score: number | null
          verification_status: string
          verified_at: string | null
          website: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "leads"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_due_warmup_sends: {
        Args: { p_limit?: number }
        Returns: {
          consecutive_failures: number
          created_at: string
          current_daily_volume: number
          health_score: number
          id: string
          imap_last_uid: number | null
          imap_uid_validity: number | null
          last_activity_at: string | null
          last_ramp_increase_at: string | null
          locked_until: string | null
          mailbox_id: string
          next_send_at: string | null
          organization_id: string
          ramp_up_percent: number
          stage: string
          started_at: string | null
          status: string
          target_daily_volume: number
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "warmup_profiles"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_mailboxes_for_reply_sync: {
        Args: never
        Returns: {
          cooldown_minutes: number
          created_at: string
          daily_limit: number
          display_name: string | null
          domain_id: string | null
          email: string
          email_provider: string
          encrypted_google_refresh_token: string | null
          encrypted_imap_password: string | null
          encrypted_microsoft_refresh_token: string | null
          encrypted_smtp_password: string | null
          hourly_limit: number
          id: string
          imap_enabled: boolean
          imap_host: string | null
          imap_last_uid: number | null
          imap_port: number
          imap_uid_validity: number | null
          imap_username: string | null
          reply_provider: string
          reply_sync_claimed_at: string | null
          reply_sync_locked_until: string | null
          smtp_host: string
          smtp_port: number
          smtp_username: string
          status: string
          updated_at: string
          user_id: string
          warmup_enabled: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "mailboxes"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_send_attempt: {
        Args: { p_campaign_lead_id: string; p_sequence_step_id: string }
        Returns: {
          attempt_count: number
          campaign_lead_id: string
          claimed_at: string
          created_at: string
          id: string
          last_error: string | null
          provider_message_id: string | null
          resolved_at: string | null
          resolved_manually: boolean
          sequence_step_id: string
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "send_attempts"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      compute_email_event_rollups: {
        Args: { p_since: string; p_until: string }
        Returns: {
          event_count: number
          event_type: string
          organization_id: string
          rollup_date: string
          subject_id: string
          subject_type: string
        }[]
      }
      confirm_send_attempt_eligible: {
        Args: {
          p_campaign_lead_id: string
          p_send_attempt_id: string
          p_sequence_step_id: string
        }
        Returns: string
      }
      is_organization_member: {
        Args: { p_organization_id: string }
        Returns: boolean
      }
      mailboxes_due_for_reply_sync: {
        Args: never
        Returns: {
          id: string
        }[]
      }
      record_rate_limit_attempt: {
        Args: {
          p_identity: string
          p_max_attempts: number
          p_scope: string
          p_window_seconds: number
        }
        Returns: {
          allowed: boolean
          retry_after_seconds: number
        }[]
      }
      record_send_failure: {
        Args: {
          p_campaign_id: string
          p_campaign_lead_id: string
          p_error_message: string
          p_lead_id: string
          p_mailbox_id: string
          p_next_send_at?: string
          p_outcome: string
          p_send_attempt_id: string
        }
        Returns: undefined
      }
      record_send_success: {
        Args: {
          p_campaign_id: string
          p_campaign_lead_id: string
          p_lead_id: string
          p_mailbox_id: string
          p_next_send_at?: string
          p_next_status: string
          p_next_step_id?: string
          p_provider_message_id: string
          p_send_attempt_id: string
        }
        Returns: undefined
      }
      release_billing_checkout: {
        Args: { p_checkout_id: string; p_claim_token: string }
        Returns: boolean
      }
      request_send_now: {
        Args: { p_campaign_lead_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

