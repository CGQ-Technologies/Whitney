import { Alert, Button, Card, Container, Group, Modal, Select, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { addTeamMember, createProject, createTeam, createTeamInvite, getProjects, getTeams, type Project, type Team, type User } from "../api/api";

export default function Dashboard({ user }: { user: User }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [inviteTeamId, setInviteTeamId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");

  const refresh = async () => {
    setLoading(true); setError("");
    try { const [p, t] = await Promise.all([getProjects(), getTeams()]); setProjects(p); setTeams(t); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load projects"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try { await action(); await refresh(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "Request failed"); return false; }
  };

  const create = async () => {
    if (!projectName.trim()) return;
    if (await run(() => createProject(projectName.trim(), teamId || undefined))) { setProjectName(""); setTeamId(null); setNewProjectOpen(false); }
  };
  const createNewTeam = async () => {
    if (!teamName.trim()) return;
    if (await run(() => createTeam(teamName.trim()))) { setTeamName(""); setNewTeamOpen(false); }
  };
  const makeInvite = async () => {
    if (!inviteTeamId) return;
    const ok = await run(async () => { const result = await createTeamInvite(inviteTeamId, inviteEmail.trim() || undefined); setInviteUrl(new URL(result.registrationUrl, window.location.origin).toString()); });
    if (ok) setInviteOpen(false);
  };
  const addExistingMember = async () => {
    if (!inviteTeamId || !inviteEmail.trim()) return;
    const ok = await run(async () => {
      const result = await addTeamMember(inviteTeamId, inviteEmail.trim());
      setInviteMessage(`${result.user.name} joined the team.`);
    });
    if (ok) { setInviteOpen(false); setInviteEmail(""); }
  };

  return <Container size="lg">
    <Modal opened={newProjectOpen} onClose={() => setNewProjectOpen(false)} title="New project">
      <Stack><TextInput label="Project name" value={projectName} onChange={e => setProjectName(e.currentTarget.value)} onKeyDown={e => e.key === "Enter" && void create()} />
        <Select label="Owner" value={teamId} onChange={setTeamId} clearable placeholder="Personal project" data={teams.map(t => ({ value: t.id, label: t.name }))} />
        <Text size="xs" c="dimmed">Team projects are available to all team members. Personal projects are private until shared.</Text><Button onClick={() => void create()}>Create project</Button></Stack>
    </Modal>
    <Modal opened={newTeamOpen} onClose={() => setNewTeamOpen(false)} title="Create a team"><Stack><TextInput label="Team name" value={teamName} onChange={e => setTeamName(e.currentTarget.value)} /><Button onClick={() => void createNewTeam()}>Create team</Button></Stack></Modal>
    <Modal opened={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite a team member"><Stack>
      <Select label="Team" value={inviteTeamId} onChange={setInviteTeamId} data={teams.map(t => ({ value: t.id, label: t.name }))} placeholder="Choose team" />
      <TextInput label="Email" type="email" value={inviteEmail} onChange={e => setInviteEmail(e.currentTarget.value)} description="Add an existing account or create a link for someone new. Leave blank for an open invitation link." />
      <Button disabled={!inviteTeamId || !inviteEmail.trim()} variant="default" onClick={() => void addExistingMember()}>Add existing user</Button>
      <Button disabled={!inviteTeamId} onClick={() => void makeInvite()}>Create invitation link</Button>
    </Stack></Modal>
    <Stack gap="lg">
      <Group justify="space-between" align="center"><div><Title order={1}>Welcome, {user.name}</Title><Text c="dimmed">Your projects and shared whiteboards</Text></div>
        <Group><Button variant="default" onClick={() => setNewTeamOpen(true)}>New team</Button><Button onClick={() => setNewProjectOpen(true)}>New project</Button></Group></Group>
      {error && <Alert color="red" title="Something went wrong" withCloseButton onClose={() => setError("")}>{error}</Alert>}
      {inviteUrl && <Alert title="Invitation link created" withCloseButton onClose={() => setInviteUrl("")}><Group justify="space-between"><Text size="sm" style={{ overflowWrap: "anywhere" }}>{inviteUrl}</Text><Button size="xs" variant="light" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>Copy</Button></Group></Alert>}
      {inviteMessage && <Alert color="green" withCloseButton onClose={() => setInviteMessage("")}>{inviteMessage}</Alert>}
      <Group justify="space-between"><Title order={2}>Projects</Title>{teams.length > 0 && <Button variant="subtle" size="xs" onClick={() => setInviteOpen(true)}>Invite to a team</Button>}</Group>
      {loading ? <Text c="dimmed">Loading projects…</Text> : projects.length === 0 ? <Text c="dimmed">No projects yet. Create a personal project or a team project to get started.</Text> :
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>{projects.map(project => <Card key={project.id} withBorder component={Link} to={`/projects/${project.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <Group justify="space-between"><Text fw={600}>{project.name}</Text><Text size="xs" c="dimmed">{project.ownerType === "team" ? teams.find(t => t.id === project.ownerTeamId)?.name || "Team" : project.access === "owner" ? "Personal" : "Shared"}</Text></Group>
          <Text size="sm" c="dimmed" mt="xs">{project.access === "team" ? "Shared with your team" : project.access === "collaborator" ? "Shared with you" : project.ownerType === "team" ? "Team project" : "Private project"}</Text>
          <Button fullWidth mt="md" variant="light">Open project</Button>
        </Card>)}</SimpleGrid>}
    </Stack>
  </Container>;
}
