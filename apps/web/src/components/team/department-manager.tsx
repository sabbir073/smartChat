'use client';

import { useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { Badge, Button, Card, Field, TextInput } from '@/components/ui';
import type { DepartmentDto } from '@/lib/types';

function suggestKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Departments — the desks a conversation can belong to.
 *
 * Deliberately inline rather than a separate page: an account has a handful of these, and burying
 * them behind another navigation item would make them feel more consequential than they are.
 */
export function DepartmentManager({
  departments,
  readOnly = false,
  onChanged,
  onError,
  onSuccess,
}: {
  departments: DepartmentDto[];
  /** Somebody who may see the desks but not rearrange them. */
  readOnly?: boolean;
  onChanged: () => void;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy(true);
    try {
      await api.post('/team/departments', {
        name: trimmed,
        key: suggestKey(trimmed) || 'department',
        isDefault: departments.length === 0,
      });
      setName('');
      setAdding(false);
      onSuccess('Department created');
      onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'The department could not be created');
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(department: DepartmentDto) {
    setBusy(true);
    try {
      await api.patch(`/team/departments/${department.id}`, { isDefault: true });
      onSuccess(`${department.name} is now the default`);
      onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'That could not be changed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(department: DepartmentDto) {
    setBusy(true);
    try {
      await api.delete(`/team/departments/${department.id}`);
      onSuccess(`${department.name} removed`);
      onChanged();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'That could not be removed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Departments</h2>
          <p className="mt-0.5 text-[13px] text-ink-subtle">
            Desks a conversation can belong to, so an inbox can be split by responsibility rather
            than by website.
          </p>
        </div>
        {!adding && !readOnly && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a department
          </Button>
        )}
      </div>

      {adding && (
        <form
          onSubmit={create}
          className="flex flex-wrap items-end gap-2 border-b border-border px-5 py-4"
        >
          <div className="min-w-[220px] flex-1">
            <Field label="Name" required>
              {({ id }) => (
                <TextInput
                  id={id}
                  autoFocus
                  value={name}
                  maxLength={60}
                  placeholder="Billing"
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
          </div>
          <Button type="submit" loading={busy} disabled={name.trim() === ''}>
            Create
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setAdding(false);
              setName('');
            }}
          >
            Cancel
          </Button>
        </form>
      )}

      {departments.length === 0 ? (
        <p className="px-5 py-6 text-center text-[13px] text-ink-subtle">
          No departments yet. Everything lands in one queue, which is fine until it is not.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {departments.map((department) => (
            <li
              key={department.id}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">
                  {department.name}
                  {department.isDefault && (
                    <span className="ml-2 align-middle">
                      <Badge tone="brand">Default</Badge>
                    </span>
                  )}
                </p>
                <p className="truncate text-[12px] text-ink-subtle">{department.key}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!readOnly && !department.isDefault && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void makeDefault(department)}
                  >
                    Make default
                  </Button>
                )}
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(department)}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
