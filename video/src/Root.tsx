import { Composition } from 'remotion';
import { FilmComposition } from './FilmComposition';
import { buildTimeline, FilmProps, FORMATS } from './types';

const defaultProps: FilmProps = {
  sources: [],
  cuts: [],
  audioSourceId: null,
  fps: 30,
  format: '4:5',
};

export const Root: React.FC = () => (
  <Composition
    id="Film"
    component={FilmComposition}
    width={1080}
    height={1350}
    fps={30}
    durationInFrames={30}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => {
      const { width, height } = FORMATS[props.format ?? '4:5'];
      return {
        durationInFrames: buildTimeline(props).durationInFrames,
        fps: props.fps,
        width,
        height,
      };
    }}
  />
);
