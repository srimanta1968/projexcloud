'use client';

import Link from 'next/link';
import { useState } from 'react';
import RegisterForm from '../../components/RegisterForm';

/**
 * /register — personal account only (no tenant created). Used by people who
 * were invited to an existing tenant. New customers should use /signup
 * (which creates a person + org + tenant in one flow).
 */
export default function RegisterPage(): JSX.Element {
  const [welcome, setWelcome] = useState<{ userId: string; email: string } | null>(null);

  if (welcome) {
    return (
      <main style={{ maxWidth: 640, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Welcome, {welcome.email}</h1>
        <p>Your user ID is <code>{welcome.userId}</code>.</p>
        <p style={{ color: '#5a6573' }}>
          Your personal account is created but you're not attached to any workspace yet.
          Ask your workspace admin to invite this email, or{' '}
          <Link href="/signup">create your own workspace</Link>.
        </p>
        <p style={{ marginTop: 24, fontSize: 13, color: '#7a8597' }}>
          Already signed in?  <Link href="/dashboard">Go to your workspace dashboard</Link>.
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Create your personal account</h1>
      <p style={{ color: '#5a6573' }}>
        Use this if you've been invited to a ProjexCloud workspace.
        If you want to start a new workspace for your company,{' '}
        <Link href="/signup"><strong>sign up here</strong></Link> instead.
      </p>
      <RegisterForm onSuccess={(userId, email) => setWelcome({ userId, email })} />
    </main>
  );
}
