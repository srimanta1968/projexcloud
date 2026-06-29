'use client';

import { FormEvent, useState } from 'react';
import { Button, Field, Input } from '@projexlight/design-system';
import { apiPut } from '../../lib/apiClient';

/**
 * /profile — profile completion. Lets a user who signed up with email-only set
 * their display name, phone and an avatar reference. Saves via PUT /api/me/profile
 * (name + avatar -> L2 profile band, phone -> alias); the result flows to the
 * header badge, members list and tenant-contact resolution.
 */
export default function ProfilePage(): JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatar, setAvatar] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await apiPut('/api/me/profile', {
        display_name: displayName || undefined,
        phone: phone || undefined,
        avatar: avatar || undefined,
      });
      setSaved(true);
    } catch (err) {
      const x = err as { error?: string; status?: number };
      setError(x.status === 401 ? 'Please sign in to update your profile.' : x.error ?? 'Could not save your profile.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="mx-auto mt-16 max-w-md px-4">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Complete your profile</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Add your name, phone and an avatar so teammates can recognise and reach you.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <Field label="Full name" htmlFor="p-name">
          <Input id="p-name" value={displayName} autoComplete="name" onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Phone" htmlFor="p-phone">
          <Input id="p-phone" type="tel" value={phone} autoComplete="tel" onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Avatar URL" htmlFor="p-avatar">
          <Input id="p-avatar" type="url" value={avatar} placeholder="https://…" onChange={(e) => setAvatar(e.target.value)} />
        </Field>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {saved && <p role="status" className="text-sm text-[#1f8a5b]">Saved. Your profile is updated.</p>}
        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? 'Saving…' : 'Save profile'}
        </Button>
      </form>
    </main>
  );
}
