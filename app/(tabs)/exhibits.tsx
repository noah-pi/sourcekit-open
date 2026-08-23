// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Exhibits — encrypted library of every exhibit this device has sealed.
 * Thumbnails are decrypted on demand into an ephemeral cache (wiped on lock).
 * Each cell carries at most two quiet badges: the
 * lock — sealed is the default state — and a pin when location OR wifi
 * data is embedded. Small glyphs on translucent dark discs, bottom-left.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Dimensions,
  RefreshControl,
  Alert,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, radii, useThemedStyles, useEffectiveScheme } from '../../src/theme';
import { useStore } from '../../src/store/useStore';
import { listItems, decryptThumbToCache, ensureVideoThumb, decryptAudioSnippet, deleteItem, getRecord, ensureEntryFlags, type VaultIndexEntry, type VaultFlags } from '../../src/vault/vaultFs';
import { exportEntriesToCsv, exportEntriesToGeoJson, exportEntriesToKml, type ExportEntry } from '../../src/lib/proofBundle';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { subscribeSeals, subscribeSealJobs, retrySealJob, discardSealJob, cancelSealJob, resumeSealQueue, type SealJobSnapshot } from '../../src/provenance/sealQueue';
import { ScreenTitle, EmptyState, Chip, Button, Mono } from '../../src/components/ui';

// Grid geometry per the 0.17.0 mockup: 3 columns, 9px gutters, 16px page
// padding, square tiles (.grid{gap:9px;padding:4px 16px 0}).
const COLS = 3;
const GAP = 9;
const PAD = 16;
const CELL = (Dimensions.get('window').width - 2 * PAD - GAP * (COLS - 1)) / COLS;

const JOB_ICON: Record<SealJobSnapshot['kind'], keyof typeof Ionicons.glyphMap> = {
  photo: 'image-outline',
  video: 'videocam-outline',
  audio: 'mic-outline',
};

/**
 * Seal-failure visibility: vault insertion is the LAST step of sealing, so
 * a failed seal leaves nothing in the grid of its own. This row states the
 * failed job plainly — what kind, when it was captured, the
 * verbatim error — and offers a retry (the queue's own failure logic is
 * unchanged; a retry that still fails is marked failed again).
 */
/**
 * Seal-failure card: the state, stated plainly — what
 * happened, that the capture is safe, two actions, and the verbatim error
 * one drawer down in Full details. Remove discards the queued draft.
 */
function FailedSealRow({ job }: { job: SealJobSnapshot }) {
  const styles = useThemedStyles(buildStyles);
  // Busy guard: a double-tap must not fire two retries of the same job.
  const [retrying, setRetrying] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const missing = !!job.error && /missing|no such file|not exist/i.test(job.error);
  const onRetry = () => {
    if (retrying) return;
    setRetrying(true);
    void retrySealJob(job.id)
      .catch(() => {})
      .finally(() => setRetrying(false));
  };
  const onRemove = () => {
    Alert.alert(
      'Remove this capture?',
      'The unsealed draft is deleted. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void discardSealJob(job.id) },
      ],
    );
  };
  return (
    <View style={styles.attentionRow}>
      <View style={styles.attentionBody}>
        <Text style={styles.attentionKind}>
          {job.kind === 'photo' ? 'Photo' : job.kind === 'video' ? 'Video' : 'Audio'} ·{' '}
          {new Date(job.capturedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </Text>
        <Text style={styles.attentionTitle}>
          {missing
            ? 'Capture file missing.'
            : `The seal didn’t finish. The ${job.kind === 'photo' ? 'photo' : job.kind === 'video' ? 'video' : 'recording'} is safe in the queue.`}
        </Text>
        <View style={styles.attentionActions}>
          {!missing ? (
            <Button small tone="secondary" icon="refresh-outline" label={retrying ? 'Retrying…' : 'Retry seal'} onPress={onRetry} disabled={retrying} />
          ) : null}
          <Button small tone="secondary" icon="trash-outline" label="Remove" onPress={onRemove} />
        </View>
        {job.error ? (
          <>
            <Pressable style={styles.attentionDetailsToggle} onPress={() => setDetailsOpen((o) => !o)} hitSlop={8}>
              <Ionicons name={detailsOpen ? 'chevron-down' : 'chevron-forward'} size={13} color={colors.textDim} />
              <Text style={styles.attentionDetailsText}>Full details</Text>
            </Pressable>
            {detailsOpen ? (
              <Mono size="xs" color={colors.warn} style={styles.attentionError}>{job.error}</Mono>
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A queued or in-flight seal renders IN THE GRID as a loading square —
 * the capture already has a place here; it just isn't sealed yet.
 * A QUEUED job is selectable like any sealed cell — Select
 * mode can cancel it. An in-flight ('sealing') job is not: the pump has
 * claimed it and a seal in progress never loses work to a stray tap.
 */
function PendingSealTile({ job, selecting, selected, onToggle }: {
  job: SealJobSnapshot;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const styles = useThemedStyles(buildStyles);
  // 0.18.4 (Noah: "allow you to also remove/cancel queued/sealing ones"):
  // sealing tiles are selectable too — a mid-seal cancel is honored at the
  // pump's pre-write checkpoints (sealQueue.cancelSealJob), never mid-write.
  // The selection dot was also missing here entirely; it now matches the
  // sealed cells exactly.
  const selectable = job.state === 'pending' || job.state === 'sealing';
  const inner = (
    <>
      {job.state === 'sealing' ? (
        <ActivityIndicator color={colors.accent} size="small" />
      ) : (
        <Ionicons name="time-outline" size={18} color={colors.textFaint} />
      )}
      <Text style={styles.tileCap}>{job.state === 'sealing' ? 'sealing…' : 'queued'}</Text>
    </>
  );
  if (!selecting || !selectable) {
    return <View style={[styles.tile, styles.pendingTile]}>{inner}</View>;
  }
  return (
    <TouchableOpacity
      style={[styles.tile, styles.pendingTile, selected && styles.cellSelected]}
      activeOpacity={0.8}
      onPress={onToggle}
      accessibilityLabel={`${job.state === 'sealing' ? 'Sealing' : 'Queued'} ${job.kind ?? 'capture'}, tap to ${selected ? 'deselect' : 'select'}`}
      accessibilityRole="button"
    >
      {inner}
      <View style={[styles.selectDot, selected && styles.selectDotOn]}>
        {selected ? <Ionicons name="checkmark" size={12} color="#fff" /> : null}
      </View>
    </TouchableOpacity>
  );
}

/**
 * Each cell decrypts only its small sealed thumbnail when it mounts (i.e.
 * when it scrolls into view). decryptThumbToCache memoizes aggressively, so
 * re-mounts while scrolling are a cheap existence check, not a re-decrypt.
 * Memoized so grid scroll doesn't re-render every visible cell.
 */
const VaultCell = React.memo(function VaultCell({ item, onPress, selecting, selected }: {
  item: VaultIndexEntry;
  onPress: () => void;
  selecting: boolean;
  selected: boolean;
}) {
  const styles = useThemedStyles(buildStyles);
  const scheme = useEffectiveScheme();
  const [uri, setUri] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  // Badge flags: sealed entries carry them in the index;
  // legacy entries are backfilled once from the record — never from media.
  const [flags, setFlags] = useState<VaultFlags | null>(item.flags ?? null);
 // Pin badge fact #2: wifi embedded. The index flags bundle wifi
  // into `identifying`, so the wifi claim itself is read from the sealed
  // record — but only when location alone doesn't already justify the pin.
  const [wifi, setWifi] = useState(false);
  const hasLocation = item.hasLocation || flags?.location === true;

  useEffect(() => {
    // Photos AND videos carry vault-sealed thumbnails (0.14.0 — videos were
    // bare icons before). Legacy videos without one get a lazy backfill: one
    // frame grabbed from the decrypted media, sealed beside it, then shown.
    // The full-item fallback is photo-only (a video decrypts to an
    // unrenderable .mp4 — 200 MB for a broken image).
    if (item.kind === 'photo' || item.kind === 'video') {
      let mounted = true;
      decryptThumbToCache(item.id, { fallbackToFull: item.kind === 'photo' })
        .then((u) => mounted && setUri(u))
        .catch(() => {
          if (item.kind !== 'video') return;
          // No sealed thumbnail — a pre-thumbnail legacy video. Backfill
          // once; a failure leaves the honest placeholder icon.
          void ensureVideoThumb(item.id).then((u) => u && mounted && setUri(u));
        });
      return () => {
        mounted = false;
      };
    }
    if (item.kind === 'audio') {
      let mounted = true;
      decryptAudioSnippet(item.id)
        .then((s) => mounted && setSnippet(s))
        .catch(() => {});
      return () => {
        mounted = false;
      };
    }
  }, [item.id, item.kind]);

  useEffect(() => {
    if (item.flags) { setFlags(item.flags); return; }
    let mounted = true;
    ensureEntryFlags(item)
      .then((f) => mounted && f && setFlags(f))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [item.id, item.flags]);

  useEffect(() => {
    if (hasLocation) return; // the pin is already justified — skip the read
    let mounted = true;
    getRecord(item.id)
      .then((rec) => {
        // An object claim only — 'redacted' / 'unavailable' / null mean absent.
        const w = rec?.context?.wifi;
        if (mounted) setWifi(!!w && typeof w === 'object');
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [item.id, hasLocation]);

  return (
    <TouchableOpacity style={[styles.tile, selecting && selected && styles.cellSelected]} activeOpacity={0.8} onPress={onPress}>
      {(item.kind === 'photo' || item.kind === 'video') && uri ? (
        <Image source={{ uri }} style={styles.thumb} contentFit="cover" transition={0} cachePolicy="memory-disk" />
      ) : item.kind === 'audio' && snippet ? (
        // The audio thumbnail is the exhibit's own first words — sealed
        // beside the media, decrypted on demand like any thumbnail.
        <View style={[styles.thumb, styles.thumbSnippet]}>
          <Ionicons name="mic" size={13} color={colors.textDim} />
          <Text style={styles.thumbSnippetText} numberOfLines={4}>
            {snippet}
          </Text>
        </View>
      ) : (
        // No thumbnail: the mockup's quiet placeholder — a 135deg gradient
        // with a centered media-type glyph, nothing louder.
        <LinearGradient
          colors={scheme === 'dark' ? ['#1F1F25', '#17171B'] : ['#EEEEF2', '#E3E3EA']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.thumb, styles.thumbPlaceholder]}
        >
          <Ionicons
            name={item.kind === 'video' ? 'videocam-outline' : item.kind === 'audio' ? 'mic-outline' : 'image-outline'}
            size={24}
            color={colors.textFaint}
          />
        </LinearGradient>
      )}
      {selecting ? (
        <View style={[styles.selectDot, selected && styles.selectDotOn]}>
          {selected ? <Ionicons name="checkmark" size={12} color="#fff" /> : null}
        </View>
      ) : (
 // Badge row: at most two quiet discs, bottom-left. The lock
        // is always there — sealed is the default state. The pin appears
        // only when location OR wifi data is actually embedded. No identity
        // badge, no bright colors: small dim glyphs on translucent discs.
        <View style={styles.badgeRow}>
          <View style={styles.badge} accessible accessibilityLabel="Sealed">
            <Ionicons name="lock-closed" size={13} color="#FFFFFF" />
          </View>
          {hasLocation || wifi ? (
            <View style={styles.badge} accessible accessibilityLabel="Location or Wi-Fi data embedded">
              <Ionicons name="location" size={13} color="#FFFFFF" />
            </View>
          ) : null}
        </View>
      )}
      {item.kind !== 'photo' ? (
        <Text style={styles.kindCap}>{item.kind === 'video' ? 'Video' : 'Audio'}</Text>
      ) : null}
    </TouchableOpacity>
  );
});

export default function VaultScreen() {
  const styles = useThemedStyles(buildStyles);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { vaultVersion, unlocked } = useStore();
  const [items, setItems] = useState<VaultIndexEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [sealing, setSealing] = useState(0);
  const [sealJobs, setSealJobs] = useState<SealJobSnapshot[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  // The selection mixes sealed exhibits (bare ids) and queued captures
  // ('job:<id>' keys, 0.18.3) — one Select mode, one Remove action; each
  // kind goes through its own discard path.
  const splitSelection = () => {
    const itemIds: string[] = [];
    const jobIds: string[] = [];
    for (const s of selected) {
      if (s.startsWith('job:')) jobIds.push(s.slice(4));
      else itemIds.push(s);
    }
    return { itemIds, jobIds };
  };

  const confirmDeleteSelected = () => {
    const { itemIds, jobIds } = splitSelection();
    const n = itemIds.length;
    const m = jobIds.length;
    if ((n === 0 && m === 0) || deleting) return;
    const sealedCopy = 'These are the only sealed copies. The collection is encrypted on this device and its key never leaves the OS keychain, so no readable copy exists anywhere else. Deleted exhibits cannot be recovered or re-created. Shared/exported copies elsewhere are unaffected.';
    // Sealing jobs are cancellable too — the copy states the one
    // case a discard can't intercept (a seal already past its final step).
    const queuedCopy = 'Queued or sealing captures are discarded unsealed — their encrypted drafts are deleted. A seal already past its final step completes and lands as a sealed exhibit. This cannot be undone.';
    Alert.alert(
      n > 0
        ? `Delete ${n + m} item${n + m === 1 ? '' : 's'}?`
        : `Discard ${m} queued capture${m === 1 ? '' : 's'}?`,
      n > 0 ? sealedCopy + (m > 0 ? `\n\n${queuedCopy}` : '') : queuedCopy,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: n > 0 ? `Delete ${n + m}` : `Discard ${m}`,
          style: 'destructive',
          onPress: () => {
            setDeleting(true);
            void (async () => {
              try {
                for (const id of jobIds) await cancelSealJob(id);
                for (const id of itemIds) await deleteItem(id);
                exitSelect();
                await load();
              } finally {
                setDeleting(false);
              }
            })();
          },
        },
      ]
    );
  };

  /**
   * Desk handoff: export the metadata index of the selected items —
   * CSV for the spreadsheet, GeoJSON/KML for the map. Media stays in the
   * vault; this is the desk's intake list, matched to proofs by hash.
   */
  const doExport = async (format: 'csv' | 'geojson' | 'kml') => {
    setExporting(true);
    try {
      const chosen = items.filter((i) => selected.has(i.id));
      const entries: ExportEntry[] = [];
      for (const item of chosen) {
        const rec = await getRecord(item.id).catch(() => null);
        const loc = rec?.context.location;
        const confirmed = rec?.ots?.submissions.filter((x) => x.state === 'confirmed') ?? [];
        entries.push({
          id: item.id,
          createdAt: item.createdAt,
          kind: item.kind,
          sha256: item.sha256,
          bytes: item.bytes,
          fingerprint: item.fingerprint,
          motionVerdict: item.motionVerdict ?? null,
          lat: typeof loc === 'object' ? loc.lat : null,
          lon: typeof loc === 'object' ? loc.lon : null,
          locationState: typeof loc === 'object' ? 'present' : loc === 'redacted' ? 'redacted' : 'unavailable',
          otsState: !rec?.ots ? 'none' : confirmed.length > 0 ? 'confirmed' : 'pending',
          otsBlockHeight: confirmed[0]?.blockHeight ?? null,
          assignment: rec?.assignment?.label ?? null,
        });
      }
      const body =
        format === 'csv' ? exportEntriesToCsv(entries)
        : format === 'geojson' ? exportEntriesToGeoJson(entries)
        : exportEntriesToKml(entries);
      const path = `${FileSystem.cacheDirectory}exhibit-index.${format === 'geojson' ? 'geojson' : format}`;
      await FileSystem.writeAsStringAsync(path, body);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
      exitSelect();
    } finally {
      setExporting(false);
    }
  };

  const exportSelected = () => {
    // Queued captures have no sealed record yet — nothing to export; only
 // real exhibits count toward the metadata export.
    const n = items.filter((i) => selected.has(i.id)).length;
    if (n === 0 || exporting) return;
    Alert.alert(
      `Export ${n} item${n === 1 ? '' : 's'} · metadata only`,
      'The intake list: hashes, times, signer fingerprints, locations where recorded, anchor state. Media stays in the collection; proofs and media are matched by hash later.',
      [
        { text: 'CSV (spreadsheet)', onPress: () => void doExport('csv') },
        { text: 'GeoJSON (map)', onPress: () => void doExport('geojson') },
        { text: 'KML (Earth)', onPress: () => void doExport('kml') },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const load = useCallback(async () => {
    setItems(await listItems());
  }, []);

  // Export only applies to sealed exhibits — a selection of nothing but
  // queued captures disables it honestly.
  const selectedHasItems = items.some((i) => selected.has(i.id));

  useEffect(() => {
    if (unlocked) {
      void resumeSealQueue(); // finish anything captured while the app was away
      load();
    }
  }, [vaultVersion, unlocked]);

  useEffect(() => subscribeSeals(setSealing), []);
  useEffect(() => subscribeSealJobs(setSealJobs), []);

  // Failed seals surface in the collapsed Needs-attention header; queued
  // and in-flight seals render as loading squares at the front of the grid.
  const [attentionOpen, setAttentionOpen] = useState(false);
  const failedJobs = sealJobs.filter((j) => j.state === 'failed');
  const activeJobs = sealJobs.filter((j) => j.state !== 'failed');
  const gridData: ({ job: SealJobSnapshot } | VaultIndexEntry)[] = [
    ...activeJobs.map((job) => ({ job })),
    ...items,
  ];

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        {/* BETA tag: the same ScreenTitle tag prop the Settings header uses
            for "in beta" — same tokens, same styling (0.18.2, Noah: the word
            belongs on the screen header, not the tab-bar label). */}
        <ScreenTitle title="Exhibits" tag="in beta" subtitle="Manage media. Stored locally." />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {items.length > 0 ? (
            <Chip label={`${items.length} exhibit${items.length === 1 ? '' : 's'}`} tone="neutral" icon="albums-outline" />
          ) : null}
          {/* Select mode covers sealed exhibits AND queued captures (0.18.3,
              Noah) — so it must be reachable when the grid holds only
              queued work. 0.18.4: sealing jobs are selectable too, so any
              active job keeps the toggle reachable. */}
          {items.length > 0 || activeJobs.length > 0 ? (
            <TouchableOpacity onPress={selecting ? exitSelect : () => setSelecting(true)}>
              <Text style={styles.selectToggle}>{selecting ? 'Cancel' : 'Select'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <FlatList
        data={gridData}
        keyExtractor={(i) => ('job' in i ? `job-${i.job.id}` : i.id)}
        numColumns={COLS}
        contentContainerStyle={styles.gridContent}
        initialNumToRender={12}
        windowSize={7}
        maxToRenderPerBatch={9}
        updateCellsBatchingPeriod={30}
        removeClippedSubviews
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
        ListHeaderComponent={
          // Needs attention: collapsed by default — one quiet header line
          // with the count; tap opens the failure cards. No jobs, no chrome.
          failedJobs.length === 0 ? null : (
            <View style={styles.attentionSection}>
              <Pressable style={styles.attentionToggle} onPress={() => setAttentionOpen((o) => !o)} hitSlop={8}>
                <Text style={styles.attentionToggleText}>Needs attention · {failedJobs.length}</Text>
                <Ionicons name={attentionOpen ? 'chevron-up' : 'chevron-forward'} size={14} color={colors.textDim} />
              </Pressable>
              {attentionOpen ? failedJobs.map((j) => <FailedSealRow key={j.id} job={j} />) : null}
            </View>
          )
        }
        ListEmptyComponent={
          <EmptyState
            icon="albums-outline"
            title="Nothing signed yet"
            body="Everything you capture is signed and kept here. Offline and encrypted."
          />
        }
        renderItem={({ item }) =>
          'job' in item ? (
            <PendingSealTile
              job={item.job}
              selecting={selecting}
              selected={selected.has(`job:${item.job.id}`)}
              onToggle={() => toggleSelect(`job:${item.job.id}`)}
            />
          ) : (
            <VaultCell
              item={item}
              selecting={selecting}
              selected={selected.has(item.id)}
              onPress={() => (selecting ? toggleSelect(item.id) : router.push(`/asset/${item.id}`))}
            />
          )
        }
      />

      {selecting ? (
        // 0.18.4 (Noah: the bar overlapped the tab bar): the pill tab bar
        // is absolutely positioned OVER this screen — the select bar must
        // clear it (the layout's own convention: inset + 64px pill + 10).
        <View style={[styles.selectBar, { marginBottom: Math.max(insets.bottom, 12) + 64 + 10 }]}>
          <Text style={styles.selectCount}>
            {selected.size === 0 ? 'Tap items to select' : `${selected.size} selected`}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <TouchableOpacity
              style={[styles.exportButton, (!selectedHasItems || exporting || deleting) && { opacity: 0.4 }]}
              disabled={!selectedHasItems || exporting || deleting}
              onPress={exportSelected}
            >
              <Ionicons name="download-outline" size={16} color={colors.accent} />
              <Text style={styles.exportButtonText}>{exporting ? 'Exporting…' : 'Export'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.deleteButton, (selected.size === 0 || deleting) && { opacity: 0.4 }]}
              disabled={selected.size === 0 || deleting}
              onPress={confirmDeleteSelected}
            >
              <Ionicons name="trash-outline" size={16} color="#fff" />
              <Text style={styles.deleteButtonText}>{deleting ? 'Removing…' : 'Remove'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const buildStyles = () => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  // Each cell carries GAP/2 margin on every side, so the content container
  // insets by the remainder to land the outer edge exactly at PAD.
  gridContent: { paddingHorizontal: PAD - GAP / 2, paddingTop: 4 },
  // Tile per the 0.17.0 mockup: square, 11px radius, 1px hairline border.
  tile: {
    width: CELL,
    aspectRatio: 1,
    margin: GAP / 2,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  cellSelected: { borderWidth: 2, borderColor: colors.accent },
  selectDot: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.9)',
    backgroundColor: 'rgba(10,13,16,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectDotOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  selectToggle: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '600', paddingVertical: 4 },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  selectCount: { color: colors.textDim, fontSize: fontSize.sm },
  exportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  exportButtonText: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '600' },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.danger,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  deleteButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },
  // Needs-attention section: amber-toned failure rows (the error is the
  // point — verbatim, wrapped, selectable) and muted queued/sealing rows.
  attentionSection: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
  attentionToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  attentionToggleText: { color: colors.textDim, fontSize: fontSize.sm, fontWeight: '600' },
  attentionRow: {
    backgroundColor: colors.warnSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  attentionBody: { flex: 1, gap: spacing.xs },
  attentionTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600', lineHeight: 18 },
  attentionKind: { color: colors.textDim, fontSize: fontSize.xs, fontWeight: '600' },
  attentionError: { lineHeight: 15 },
  attentionActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  attentionDetailsToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xs },
  attentionDetailsText: { color: colors.textDim, fontSize: fontSize.sm },
  pendingTile: {
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Tile caption per the mockup (.tile .cap): bottom-left, 8.5px, muted.
  tileCap: {
    position: 'absolute',
    left: 8,
    bottom: 6,
    fontSize: 8.5,
    color: colors.textDim,
  },
  thumb: { width: '100%', height: '100%', backgroundColor: colors.surface },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  thumbSnippet: { padding: spacing.sm, justifyContent: 'flex-start', gap: 5 },
  thumbSnippetText: { color: colors.textDim, fontSize: 10, lineHeight: 13, fontStyle: 'italic' },
  // Badge row: small translucent dark discs with a
  // hairline light border, dim glyphs, bottom-left, 4px apart. Quiet by
  // design — the lock is the default state, not an alarm.
  badgeRow: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    flexDirection: 'row',
    gap: 4,
  },
  badge: {
    // 0.18.5 contrast pass (Noah: "even less visible than before — we need
    // contrast"): a SOLID black disc with a pure-white glyph and a strong
    // light ring — legible against any photo, bright or busy. Translucency
    // was the failure mode; gone.
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#0B0B0D',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Kind caption for non-photo tiles — same cap language as the mockup,
  // anchored bottom-right so it never collides with the badge row.
  // Solid chip, white text (was dim text directly on
  // the thumbnail — unreadable on busy frames).
  kindCap: {
    position: 'absolute',
    right: 8,
    bottom: 6,
    fontSize: 8.5,
    fontWeight: '700',
    color: '#FFFFFF',
    backgroundColor: '#0B0B0D',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    overflow: 'hidden',
  },
});
