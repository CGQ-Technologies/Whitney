import { Alert, Button, Card, Container, Group, Modal, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { addCollaborator, createProjectInvite, createWhiteboard, getProject, getProjectWhiteboards, type Project as ProjectType, type Whiteboard } from "../api/api";

export default function ProjectPage() {
  const { id = "" } = useParams();
  const [project, setProject] = useState<ProjectType | null>(null);
  const [boards, setBoards] = useState<Whiteboard[]>([]);
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(""); setLoading(true);
    try { const [p, b] = await Promise.all([getProject(id), getProjectWhiteboards(id)]); setProject(p); setBoards(b); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load project"); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { void refresh(); }, [refresh]);
  const createBoard = async () => {
    if (!title.trim()) return;
    setBusy(true); setError("");
    try { await createWhiteboard(id, title.trim()); setTitle(""); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create whiteboard"); }
    finally { setBusy(false); }
  };
  const shareByEmail = async () => {
    if (!email.trim()) return;
    setBusy(true); setError("");
    try { await addCollaborator(id, email.trim()); setEmail(""); setShareOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not share project"); }
    finally { setBusy(false); }
  };
  const makeInvite = async () => {
    setBusy(true); setError("");
    try { const result = await createProjectInvite(id, inviteEmail.trim() || undefined); setInviteUrl(new URL(result.registrationUrl, window.location.origin).toString()); setShareOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create invitation"); }
    finally { setBusy(false); }
  };

  return <Container size="lg">
    <Modal opened={shareOpen} onClose={() => setShareOpen(false)} title="Share project"><Stack>
      <Text size="sm" c="dimmed">Shared users can edit every whiteboard in this project.</Text>
      <TextInput label="Add existing user by email" type="email" value={email} onChange={e => setEmail(e.currentTarget.value)} />
      <Button loading={busy} onClick={() => void shareByEmail()}>Share with user</Button>
      <TextInput label="Invite a new user by email (optional)" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.currentTarget.value)} description="Leave blank for a reusable invite link." />
      <Button variant="default" loading={busy} onClick={() => void makeInvite()}>Create invite link</Button>
    </Stack></Modal>
    <Stack>
      <Text size="sm"><Link to="/">← Projects</Link></Text>
      {loading ? <Text c="dimmed">Loading project…</Text> : project && <>
        <Group justify="space-between"><div><Title order={1}>{project.name}</Title><Text c="dimmed">{project.ownerType === "team" ? "Team project" : "Personal project"}</Text></div>
          {project.ownerType === "user" && project.access === "owner" && <Button variant="default" onClick={() => setShareOpen(true)}>Share</Button>}</Group>
        {error && <Alert color="red" title="Something went wrong">{error}</Alert>}
        {inviteUrl && <Alert title="Invitation link created" withCloseButton onClose={() => setInviteUrl("")}><Group justify="space-between"><Text size="sm" style={{ overflowWrap: "anywhere" }}>{inviteUrl}</Text><Button size="xs" variant="light" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>Copy</Button></Group></Alert>}
        <Group align="end"><TextInput label="New whiteboard" placeholder="e.g. Product ideas" value={title} onChange={e => setTitle(e.currentTarget.value)} onKeyDown={e => e.key === "Enter" && void createBoard()} style={{ flex: 1 }} /><Button loading={busy} onClick={() => void createBoard()}>Create whiteboard</Button></Group>
        <Title order={2}>Whiteboards</Title>
        {boards.length === 0 ? <Text c="dimmed">No whiteboards in this project yet.</Text> : <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>{boards.map(board => <Card key={board.id} withBorder component={Link} to={`/whiteboard/${board.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Text fw={600}>{board.title}</Text><Text size="sm" c="dimmed" mt="xs">Created {new Date(board.createdAt).toLocaleDateString()}</Text><Button fullWidth mt="md" variant="light">Open whiteboard</Button>
        </Card>)}</SimpleGrid>}
      </>}
      {error && !project && <Alert color="red" title="Could not open project">{error}</Alert>}
    </Stack>
  </Container>;
}
