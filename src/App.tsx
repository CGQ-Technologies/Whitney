import "@mantine/core/styles.css";
import "@excalidraw/excalidraw/index.css";
import { Alert, AppShell, Button, Group, MantineProvider, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { BrowserRouter as Router, Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getMe, getAuthStatus, login, bootstrap, register, logout, type User } from "./api/api";
import Dashboard from "./pages/Dashboard";
import ProjectPage from "./pages/Project";
import Whiteboard from "./pages/Whiteboard";

function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const invite = new URLSearchParams(location.search).get("token") || "";
  const [mode, setMode] = useState<"login" | "bootstrap" | "register">(invite ? "register" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const refresh = useCallback(async () => {
    try { const result = await getMe(); setUser(result.user); }
    catch {
      setUser(null);
      try { const status = await getAuthStatus(); if (status.bootstrapRequired && !invite) setMode("bootstrap"); }
      catch { /* show sign-in form; request errors are reported on submission */ }
    }
    finally { setChecked(true); }
  }, [invite]);
  useEffect(() => { void refresh(); }, [refresh]);

  if (!checked) return <Text p="xl">Checking your session…</Text>;
  if (user) {
    const isFullscreen = location.pathname.startsWith("/whiteboard/") && new URLSearchParams(location.search).get("fullscreen") === "true";
    const content = <Routes>
      <Route path="/" element={<Dashboard user={user} />} />
      <Route path="/projects/:id" element={<ProjectPage />} />
      <Route path="/whiteboard/:id" element={<Whiteboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>;
    if (isFullscreen) return content;
    return <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header><Group h="100%" px="md" justify="space-between">
        <Text size="xl" fw={700} component={Link} to="/" style={{ textDecoration: "none", color: "inherit" }}>Whitney</Text>
        <Group gap="sm"><Text size="sm" c="dimmed">{user.name}</Text><Button size="xs" variant="subtle" onClick={async () => { await logout(); setUser(null); navigate("/"); }}>Sign out</Button></Group>
      </Group></AppShell.Header>
      <AppShell.Main>{content}</AppShell.Main>
    </AppShell>;
  }

  const submit = async () => {
    setAuthError("");
    if (!email.trim() || !password || (mode !== "login" && !name.trim())) { setAuthError("Complete all required fields."); return; }
    setBusy(true);
    try {
      if (mode === "login") await login({ email, password });
      else if (mode === "bootstrap") await bootstrap({ email, name, password });
      else await register({ token: invite, email, name, password });
      await refresh();
      navigate("/", { replace: true });
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Sign in failed"); }
    finally { setBusy(false); }
  };
  return <Stack maw={420} mx="auto" mt="10vh" p="xl">
    <Title order={1}>Whitney</Title>
    <Text c="dimmed">Sign in to your team whiteboards.</Text>
    {authError && <Alert color="red" title="Could not continue">{authError}</Alert>}
    {mode !== "login" && <TextInput label="Name" value={name} onChange={e => setName(e.currentTarget.value)} />}
    <TextInput label="Email" type="email" value={email} onChange={e => setEmail(e.currentTarget.value)} />
    <PasswordInput label="Password" value={password} onChange={e => setPassword(e.currentTarget.value)} />
    <Button loading={busy} onClick={() => void submit()}>{mode === "login" ? "Sign in" : mode === "bootstrap" ? "Create first account" : "Accept invitation"}</Button>
    {invite ? <Text size="sm" c="dimmed">You’ve been invited. Create an account to join.</Text> : <Group justify="space-between">
      <Button variant="subtle" size="xs" onClick={() => { setMode(mode === "login" ? "bootstrap" : "login"); setAuthError(""); }}>{mode === "login" ? "First account setup" : "Back to sign in"}</Button>
      {mode === "bootstrap" && <Text size="xs" c="dimmed">Only works before the first account exists.</Text>}
    </Group>}
  </Stack>;
}

export default function App() {
  return <MantineProvider defaultColorScheme="dark"><Router><AuthGate /></Router></MantineProvider>;
}
