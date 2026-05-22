'use client';

import { useState } from 'react';
import RegisterForm from '../../components/RegisterForm';

/**
 * /register — public sign-up page for the tenant workspace.
 */
export default function RegisterPage(): JSX.Element {
  const [welcome, setWelcome] = useState<{ userId: string; email: string } | null>(null);

  if (welcome) {
    return (
      <main>
        <h1>Welcome, {welcome.email}</h1>
        <p>Your user ID is {welcome.userId}.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Create your account</h1>
      <RegisterForm onSuccess={(userId, email) => setWelcome({ userId, email })} />
    </main>
  );
}
