'use client';

import { useState } from 'react';
import { Button, Card, CardBody, EmptyState, Field, Modal, TextInput } from '@/components/ui';
import type { KbCategoryDto } from '@/lib/types';

export interface CategoryDraft {
  id?: string;
  name: string;
  slug: string;
  description: string;
  position: number;
  slugLocked: boolean;
}

export function emptyCategory(position: number): CategoryDraft {
  return { name: '', slug: '', description: '', position, slugLocked: false };
}

export function categoryDraftFrom(category: KbCategoryDto): CategoryDraft {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description ?? '',
    position: category.position,
    slugLocked: true,
  };
}

function suggest(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length >= 2 ? slug : '';
}

/**
 * The sections of the help centre.
 *
 * Removing one keeps its articles - they simply stop belonging to a section. The confirmation
 * says so, because "delete" next to a folder reads like it takes the contents with it.
 */
export function CategoryManager({
  categories,
  counts,
  canManage,
  onCreate,
  onUpdate,
  onDelete,
}: {
  categories: KbCategoryDto[];
  counts: Record<string, number>;
  canManage: boolean;
  onCreate: (draft: CategoryDraft) => Promise<void>;
  onUpdate: (id: string, draft: CategoryDraft) => Promise<void>;
  onDelete: (category: KbCategoryDto) => Promise<void>;
}) {
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [confirming, setConfirming] = useState<KbCategoryDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<CategoryDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      if (draft.id) await onUpdate(draft.id, draft);
      else await onCreate(draft);
      setDraft(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              setDraft(emptyCategory(categories.length));
            }}
          >
            New section
          </Button>
        </div>
      )}

      {categories.length === 0 ? (
        <EmptyState
          title="No sections yet"
          description="Sections group articles on the public help centre. Articles work without one."
        />
      ) : (
        <div className="space-y-2">
          {categories.map((category) => (
            <Card key={category.id}>
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-ink">{category.name}</h3>
                  <p className="mt-0.5 text-[13px] text-ink-subtle">
                    <span className="font-mono">/{category.slug}</span>
                    {' · '}
                    {counts[category.id] ?? 0} published
                    {category.description ? ` · ${category.description}` : ''}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setError(null);
                        setDraft(categoryDraftFrom(category));
                      }}
                    >
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirming(category)}>
                      Remove
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title={draft.id ? 'Edit section' : 'New section'}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void save()} loading={saving}>
                Save
              </Button>
            </div>
          }
        >
          <div className="space-y-5">
            {error && (
              <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
                {error}
              </p>
            )}
            <Field label="Name" required>
              {({ id }) => (
                <TextInput
                  id={id}
                  value={draft.name}
                  maxLength={80}
                  placeholder="Billing"
                  onChange={(event) =>
                    draft.slugLocked
                      ? set({ name: event.target.value })
                      : set({ name: event.target.value, slug: suggest(event.target.value) })
                  }
                />
              )}
            </Field>
            <Field label="Address" required>
              {({ id }) => (
                <TextInput
                  id={id}
                  value={draft.slug}
                  maxLength={80}
                  placeholder="billing"
                  onChange={(event) => set({ slug: event.target.value, slugLocked: true })}
                />
              )}
            </Field>
            <Field label="Description" hint="Shown under the section name. Optional.">
              {({ id }) => (
                <TextInput
                  id={id}
                  value={draft.description}
                  maxLength={300}
                  onChange={(event) => set({ description: event.target.value })}
                />
              )}
            </Field>
            <Field label="Position" hint="Lower numbers come first.">
              {({ id }) => (
                <TextInput
                  id={id}
                  type="number"
                  min={0}
                  max={999}
                  value={String(draft.position)}
                  onChange={(event) => set({ position: Number(event.target.value) || 0 })}
                />
              )}
            </Field>
          </div>
        </Modal>
      )}

      {confirming && (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={`Remove “${confirming.name}”?`}
          description="Its articles are kept - they stop belonging to a section and can be moved into another one."
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const target = confirming;
                  setConfirming(null);
                  void onDelete(target);
                }}
              >
                Remove section
              </Button>
            </div>
          }
        >
          <p className="text-sm text-ink-muted">
            {counts[confirming.id] ?? 0} published article
            {(counts[confirming.id] ?? 0) === 1 ? '' : 's'} will stay in the help centre.
          </p>
        </Modal>
      )}
    </div>
  );
}
