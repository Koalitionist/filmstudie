import { useMemo } from 'react';
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, useVideoConfig } from 'remotion';
import { buildTimeline, FilmProps } from './types';

// Full-frame video with optional rotation. For quarter turns the cover box is
// built with swapped dimensions and rotated into place, so the footage still
// covers the whole canvas.
const RotatedCoverVideo: React.FC<{
  src: string;
  trimBefore: number;
  rotation: number;
}> = ({ src, trimBefore, rotation }) => {
  const { width: W, height: H } = useVideoConfig();
  const rot = ((rotation % 360) + 360) % 360;
  const quarter = rot === 90 || rot === 270;
  const boxW = quarter ? H : W;
  const boxH = quarter ? W : H;
  return (
    <div
      style={{
        position: 'absolute',
        width: boxW,
        height: boxH,
        left: (W - boxW) / 2,
        top: (H - boxH) / 2,
        transform: `rotate(${rot}deg)`,
      }}
    >
      <OffthreadVideo
        src={src}
        trimBefore={trimBefore}
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  );
};

// 1080x1350 multicam program: full-frame hard cuts between sources, one
// continuous audio track (no audio jumps at cuts). The same component powers
// the /edit Player preview and the server-side render.
export const FilmComposition: React.FC<FilmProps> = (props) => {
  const { trim, segments } = useMemo(() => buildTimeline(props), [props]);
  const srcOf = (id: string) => props.sources.find((s) => s.id === id);
  const audio = props.audioSourceId ? srcOf(props.audioSourceId) : props.sources[0];

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {segments.map((seg) => {
        const source = srcOf(seg.sourceId);
        if (!source) return null;
        return (
          <Sequence key={`${seg.start}-${seg.sourceId}`} from={seg.start} durationInFrames={seg.len}>
            <RotatedCoverVideo
              src={source.src}
              trimBefore={trim[seg.sourceId] + seg.start}
              rotation={source.rotation ?? 0}
            />
          </Sequence>
        );
      })}
      {audio && <Audio src={audio.src} trimBefore={trim[audio.id] ?? 0} />}
    </AbsoluteFill>
  );
};
