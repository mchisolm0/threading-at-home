import { SignInPanel } from "./SignInPanel";

export default function SignInPage() {
  const isConfigured = process.env.NEXT_PUBLIC_CONVEX_URL !== undefined;

  return (
    <main>
      <section>
        <p>OSS Capacity</p>
        <h1>Sign in to continue.</h1>
        {isConfigured ? (
          <SignInPanel />
        ) : (
          <p>Configure NEXT_PUBLIC_CONVEX_URL to enable GitHub sign-in.</p>
        )}
      </section>
    </main>
  );
}
