"use client";

import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import type { Tables } from "@/types/database.types";
import { LEAD_STATUSES, leadSchema, type LeadInput } from "@/lib/validations/leads";
import { createLeadAction, updateLeadAction } from "@/app/(app)/leads/actions";
import { ActionError, unwrapActionResult } from "@/lib/action-result";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimezoneSelect } from "@/components/campaigns/timezone-select";

const NO_LIST = "none";

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

type LeadFormProps =
  | { mode: "create"; lead?: undefined; leadLists: Tables<"lead_lists">[]; onSuccess: () => void }
  | { mode: "edit"; lead: Tables<"leads">; leadLists: Tables<"lead_lists">[]; onSuccess: () => void };

export function LeadForm({ mode, lead, leadLists, onSuccess }: LeadFormProps) {
  const [isPending, startTransition] = useTransition();

  const form = useForm<LeadInput>({
    resolver: zodResolver(leadSchema),
    defaultValues:
      mode === "edit"
        ? {
            firstName: lead.first_name ?? "",
            lastName: lead.last_name ?? "",
            email: lead.email,
            company: lead.company ?? "",
            title: lead.title ?? "",
            status: lead.status as LeadInput["status"],
            listId: lead.list_id ?? "",
            timezone: lead.timezone ?? "",
          }
        : {
            firstName: "",
            lastName: "",
            email: "",
            company: "",
            title: "",
            listId: "",
            timezone: "",
          },
  });

  function onSubmit(values: LeadInput) {
    startTransition(async () => {
      try {
        if (mode === "create") {
          unwrapActionResult(await createLeadAction(values));
          toast.success("Lead added.");
        } else {
          await updateLeadAction(lead.id, values);
          toast.success("Lead updated.");
        }
        onSuccess();
      } catch (error) {
        toast.error(
          error instanceof ActionError
            ? error.message
            : mode === "create"
              ? "Couldn't add the lead. Try again."
              : "Couldn't update the lead. Try again.",
        );
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>First name</FormLabel>
                <FormControl>
                  <Input placeholder="Jane" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="lastName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Last name</FormLabel>
                <FormControl>
                  <Input placeholder="Cooper" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input placeholder="jane@company.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="company"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Company</FormLabel>
                <FormControl>
                  <Input placeholder="Acme Inc." {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Job title</FormLabel>
                <FormControl>
                  <Input placeholder="VP Sales" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="listId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>List</FormLabel>
                <Select
                  value={field.value || NO_LIST}
                  onValueChange={(value) => field.onChange(value === NO_LIST ? "" : value)}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="No list" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_LIST}>No list</SelectItem>
                    {leadLists.map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {mode === "edit" && (
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {LEAD_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {statusLabel(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        <FormField
          control={form.control}
          name="timezone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Timezone</FormLabel>
              <FormControl>
                <TimezoneSelect
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  emptyLabel="Use campaign timezone"
                />
              </FormControl>
              <FormDescription>
                Campaigns send within their sending hours in this timezone. Leave it on the campaign timezone if
                you don&apos;t know it.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <DialogFooter>
          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving…" : mode === "create" ? "Add lead" : "Save changes"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
