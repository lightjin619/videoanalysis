"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocalAuth } from "@/hooks/useLocalAuth";

export default function HomePage() {
  const router = useRouter();
  const { status, accountExists, createAccount, login, resetAccount } =
    useLocalAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/projects");
    }
  }, [router, status]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    if (!accountExists && password !== confirmPassword) {
      setError("The password confirmation does not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      if (accountExists) {
        await login(username, password);
      } else {
        await createAccount(username, password);
      }
      router.replace("/projects");
    } catch (authError) {
      setError(
        authError instanceof Error
          ? authError.message
          : "An error occurred while signing in."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetAccount = () => {
    const shouldReset = window.confirm(
      "Reset the saved local account? Its existing work will remain stored, but a newly created account will start with an empty workspace and cannot access that work."
    );
    if (!shouldReset) return;

    resetAccount();
    setUsername("");
    setPassword("");
    setConfirmPassword("");
    setError("");
  };

  if (status === "loading" || status === "authenticated") {
    return (
      <div className="page-status" role="status">
        Preparing the login screen.
      </div>
    );
  }

  return (
    <div className="login-page">
      <section className="login-intro">
        <span className="login-eyebrow">VIDEO ANALYSIS LAB</span>
        <h1>Discover meaningful biosignals in video.</h1>
        <p>
          Analyze videos using facial RGB signals and manage the results by
          project.
        </p>
      </section>

      <section className="login-card">
        <div>
          <span className="login-card-label">
            {accountExists ? "WELCOME BACK" : "LOCAL ACCOUNT"}
          </span>
          <h2>{accountExists ? "Sign In" : "Create a Local Account"}</h2>
          <p className="login-description">
            {accountExists
              ? "Continue with the account saved in this browser."
              : "Choose a username and password to get started."}
          </p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Username
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter your username"
              required
              autoFocus
            />
          </label>

          <label>
            Password
            <input
              type="password"
              autoComplete={accountExists ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
            />
          </label>

          {!accountExists && (
            <label>
              Confirm Password
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Re-enter your password"
                required
              />
            </label>
          )}

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="primary-button login-submit"
            type="submit"
            disabled={isSubmitting}
          >
            {isSubmitting
              ? "Processing..."
              : accountExists
                ? "Sign In"
                : "Create Account and Start"}
          </button>

          {accountExists && (
            <button
              className="login-reset"
              type="button"
              onClick={handleResetAccount}
              disabled={isSubmitting}
            >
              Reset Saved Account
            </button>
          )}
        </form>

        <p className="login-security-note">
          Account information is stored only in this browser. Your password is
          stored as a one-way hash, not as plain text.
        </p>
      </section>
    </div>
  );
}
