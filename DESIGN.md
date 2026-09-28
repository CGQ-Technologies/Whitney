# Whitney design

Whitney is an internal space for teams to think together on shared projects. A project groups whiteboards, and each whiteboard is a live Excalidraw canvas. The default experience should make it easy to find a project, open a board, and work alongside another person.

## People and ownership

- A **user** has a Whitney account and may belong to many teams.
- A **team** has many users through memberships. An existing user can join more than one team.
- A **project** has exactly one owner: either one user or one team.
- A **whiteboard** belongs to exactly one project.
- A personal project may be shared with named users. Every member of a team can access a project owned by that team.

Access is binary in the first version: someone can access and edit a project, or cannot access it. All people with access may collaborate on its whiteboards. Project viewer/editor roles and a broader RBAC system are deferred.

## Account flow

Whitney manages its own accounts. The first user bootstraps an installation. Further accounts are created through invitations; there is no public signup. A user signs in with an email and password and can sign out, ending their session. Team membership and project sharing determine what appears in their dashboard and which boards they can open.

## Project flow

1. Create a personal project or a project owned by one of your teams.
2. Create one or more whiteboards inside it.
3. Open a board from the project page. Team members or invited personal-project collaborators can open the same board.
4. Changes appear in connected collaborators' canvases. The board remains available after everyone leaves.

The dashboard should distinguish personal and team projects and show only projects the signed-in user can access. Legacy whiteboards from older Whitney versions appear in an Imported personal project when the first account is created.

## Collaboration behavior

- A board opens from a durable scene snapshot and joins a live room.
- Editors see connected participants and each other's changes without reloading.
- Independent changes to different elements should merge. Deletes remain represented so reconnecting editors cannot restore removed elements accidentally.
- Reconnecting clients receive the latest saved scene and resume collaboration.
- The server checks project access before giving a client a snapshot or accepting edits.

These are product requirements, not just transport details. The first implementation may have limitations around simultaneous edits to the same element, images, offline work, and multi-server deployment; those should be documented and refined with testing.

## Deferred work

- Project-specific roles and RBAC.
- Public sharing and anonymous editing.
- Cross-team ownership of a single project.
- AI-assisted discussion of the visible whiteboard, which remains a longer-term product goal.
