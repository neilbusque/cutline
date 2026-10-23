import React from "react";
import { Composition, registerRoot } from "remotion";
import { Film } from "./Video";
import { newProject, duration } from "../shared/model";
const Root = () => (
  <Composition
    id="Cutline"
    component={Film}
    durationInFrames={120}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ project: newProject(), mediaBase: "", preview: false }}
    calculateMetadata={({ props }) => ({
      durationInFrames: duration(props.project),
      fps: props.project.fps,
      width: props.project.width,
      height: props.project.height,
    })}
  />
);
registerRoot(Root);
