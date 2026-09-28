import { Excalidraw } from "@excalidraw/excalidraw";
import type { BinaryFileData, ExcalidrawImperativeAPI, ExcalidrawInitialDataState, ExcalidrawProps } from "@excalidraw/excalidraw/types";
import { ActionIcon, Alert, Box, Group, Loader, Pill, Text } from "@mantine/core";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { getWhiteboardData, whiteboardSocketUrl } from "../api/api";

type Element = Record<string, unknown> & { id?: string; version?: number; versionNonce?: number };
type Presence = { id: string; displayName?: string };
type WireMessage =
  | { type: "snapshot"; elements: Element[]; appState?: Record<string, unknown>; binaryFiles?: Record<string, unknown>; online?: Presence[] }
  | { type: "elements"; elements: Element[]; binaryFiles?: Record<string, unknown> }
  | { type: "presence"; online: Presence[] }
  | { type: "error"; message?: string };

const versionOf = (element: Element) => Number(element.version || 0);
const signature = (element: Element) => `${versionOf(element)}:${element.versionNonce || 0}`;
function mergeElements(base: readonly Element[], incoming: readonly Element[]) {
  const byId = new Map(base.map(element => [element.id || JSON.stringify(element), element]));
  for (const element of incoming) {
    const key = element.id || JSON.stringify(element);
    const old = byId.get(key);
    if (!old || versionOf(element) > versionOf(old) ||
      (versionOf(element) === versionOf(old) && Number(element.versionNonce || 0) > Number(old.versionNonce || 0))) byId.set(key, element);
  }
  return [...byId.values()];
}
const viewState = (state?: Record<string, unknown>) => state ? Object.fromEntries(["viewBackgroundColor", "gridSize", "zoom", "scrollX", "scrollY"].filter(key => state[key] !== undefined).map(key => [key, state[key]])) : {};

export default function Whiteboard() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const excalidrawApi = useRef<ExcalidrawImperativeAPI | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectCount = useRef(0);
  const hasSnapshot = useRef(false);
  const applyingRemote = useRef(false);
  const localElements = useRef<Element[]>([]);
  const knownElements = useRef<Map<string, string>>(new Map());
  const localFiles = useRef<Record<string, unknown>>({});
  const knownFiles = useRef<Map<string, string>>(new Map());
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting" | "offline">("connecting");
  const [presence, setPresence] = useState<Presence[]>([]);

  const isFullscreen = new URLSearchParams(location.search).get("fullscreen") === "true";
  const toggleFullscreen = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (isFullscreen) params.delete("fullscreen"); else params.set("fullscreen", "true");
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [isFullscreen, location.pathname, location.search, navigate]);

  useEffect(() => {
    if (!id) { setError("No whiteboard ID was provided."); setIsLoading(false); return; }
    let cancelled = false;
    setIsLoading(true); setError(""); hasSnapshot.current = false;
    void getWhiteboardData(id).then(data => {
      if (cancelled) return;
      const elements = (data.elements || []) as Element[];
      const files = (data.files || {}) as Record<string, unknown>;
      localElements.current = elements;
      localFiles.current = files;
      setInitialData({ elements: elements as never, appState: (data.appState || {}) as never, files: files as never });
      setIsLoading(false);
    }).catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : "Could not load whiteboard"); setIsLoading(false); } });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id || isLoading || error) return;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      setConnection(reconnectCount.current ? "reconnecting" : "connecting");
      const socket = new WebSocket(whiteboardSocketUrl(id));
      socketRef.current = socket;
      socket.onopen = () => { reconnectCount.current = 0; setConnection("connected"); };
      socket.onmessage = event => {
        let message: WireMessage;
        try { message = JSON.parse(String(event.data)) as WireMessage; } catch { return; }
        if (message.type === "error") { setError(message.message || "The collaboration connection was rejected."); return; }
        if (message.type === "presence") { setPresence(message.online || []); return; }
        if (message.type === "snapshot") {
          const serverElements = message.elements || [];
          // Keep a newer local edit if it happened while the socket was reconnecting.
          const merged = mergeElements(serverElements, localElements.current);
          const remoteFiles = message.binaryFiles || {};
          const mergedFiles = { ...remoteFiles, ...localFiles.current };
          localElements.current = merged;
          localFiles.current = mergedFiles;
          knownElements.current = new Map(serverElements.map(element => [element.id || "", signature(element)]));
          knownFiles.current = new Map(Object.entries(remoteFiles).map(([key, value]) => [key, JSON.stringify(value)]));
          setPresence(message.online || []);
          hasSnapshot.current = true;
          applyingRemote.current = true;
          excalidrawApi.current?.updateScene({ elements: merged as never, appState: viewState(message.appState) as never });
          if (Object.keys(remoteFiles).length) excalidrawApi.current?.addFiles(Object.values(remoteFiles) as BinaryFileData[]);
          window.setTimeout(() => { applyingRemote.current = false; }, 0);
          // Flush local updates made during a disconnect once the room snapshot has arrived.
          const changed = merged.filter(element => knownElements.current.get(element.id || "") !== signature(element));
          const newFiles = Object.fromEntries(Object.entries(mergedFiles).filter(([key, value]) => knownFiles.current.get(key) !== JSON.stringify(value)));
          if ((changed.length || Object.keys(newFiles).length) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "elements", elements: changed, ...(Object.keys(newFiles).length ? { binaryFiles: newFiles } : {}) }));
          return;
        }
        if (message.type === "elements") {
          const before = localElements.current;
          const merged = mergeElements(before, message.elements || []);
          localElements.current = merged;
          if (message.binaryFiles) localFiles.current = { ...localFiles.current, ...message.binaryFiles };
          for (const element of message.elements || []) if (element.id) knownElements.current.set(element.id, signature(element));
          Object.entries(message.binaryFiles || {}).forEach(([key, value]) => knownFiles.current.set(key, JSON.stringify(value)));
          applyingRemote.current = true;
          excalidrawApi.current?.updateScene({ elements: merged as never });
          if (message.binaryFiles) excalidrawApi.current?.addFiles(Object.values(message.binaryFiles) as BinaryFileData[]);
          window.setTimeout(() => { applyingRemote.current = false; }, 0);
        }
      };
      socket.onerror = () => { setConnection("reconnecting"); };
      socket.onclose = () => {
        socketRef.current = null;
        if (stopped) return;
        reconnectCount.current += 1;
        setConnection("reconnecting");
        const delay = Math.min(1000 * (2 ** Math.min(reconnectCount.current - 1, 5)), 30000);
        reconnectTimer.current = window.setTimeout(connect, delay);
      };
    };
    connect();
    return () => { stopped = true; socketRef.current?.close(); socketRef.current = null; if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current); };
  }, [id, isLoading, error]);

  const onChange: NonNullable<ExcalidrawProps["onChange"]> = (elements, _appState, files) => {
    // Excalidraw's callback may omit deleted items; tombstones must reach peers so
    // an old element cannot reappear after a reconnect or concurrent edit.
    const current = (excalidrawApi.current?.getSceneElementsIncludingDeleted() || elements) as unknown as Element[];
    const fileMap = (files || {}) as unknown as Record<string, unknown>;
    localElements.current = current;
    localFiles.current = fileMap;
    if (applyingRemote.current || !hasSnapshot.current) return;
    const changed = current.filter(element => {
      const idValue = element.id || "";
      return knownElements.current.get(idValue) !== signature(element);
    });
    const changedFiles = Object.fromEntries(Object.entries(fileMap).filter(([key, value]) => knownFiles.current.get(key) !== JSON.stringify(value)));
    if (!changed.length && !Object.keys(changedFiles).length) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "elements", elements: changed, ...(Object.keys(changedFiles).length ? { binaryFiles: changedFiles } : {}) }));
    changed.forEach(element => { if (element.id) knownElements.current.set(element.id, signature(element)); });
    Object.entries(changedFiles).forEach(([key, value]) => knownFiles.current.set(key, JSON.stringify(value)));
  };

  if (isLoading) return <Group p="xl"><Loader size="sm" /><Text>Loading whiteboard…</Text></Group>;
  if (error && !initialData) return <Box p="md"><Alert color="red" title="Could not open whiteboard">{error}<Text mt="sm"><Link to="/">Back to projects</Link></Text></Alert></Box>;
  return <Box w="100%" h={isFullscreen ? "calc(100vh - 36px)" : "calc(100vh - 100px)"} pos="relative">
    {error && <Alert pos="absolute" top={40} right={12} w={360} style={{ zIndex: 10 }} color="red" title="Collaboration error" withCloseButton onClose={() => setError("")}>{error}</Alert>}
    <Group h={36} align="center" justify="space-between">
      {!isFullscreen ? <Text size="sm" component={Link} to="/" c="dimmed" td="none">← Projects</Text> : <span />}
      <Group gap="xs"><Pill size="sm" c={connection === "connected" ? "green" : connection === "reconnecting" ? "yellow" : "dimmed"}>{connection === "connected" ? "Live" : connection === "reconnecting" ? "Reconnecting…" : connection === "offline" ? "Offline" : "Connecting…"}</Pill>
        <Text size="xs" c="dimmed">{presence.length ? `${presence.length} online${presence.map(person => person.displayName).filter(Boolean).length ? ` · ${presence.map(person => person.displayName).filter(Boolean).join(", ")}` : ""}` : ""}</Text>
        <ActionIcon onClick={toggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} variant="default" size="sm">{isFullscreen ? <IconArrowsMinimize size="1rem" /> : <IconArrowsMaximize size="1rem" />}</ActionIcon>
      </Group>
    </Group>
    {initialData && <Excalidraw initialData={initialData} excalidrawAPI={api => { excalidrawApi.current = api; }} theme="dark" UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false } }} onChange={onChange} />}
  </Box>;
}
