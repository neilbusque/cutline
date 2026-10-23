import React, { useMemo, useState } from "react";
import { Player } from "@remotion/player";
import { Film } from "../composition/Video";
import { makeClip, newProject, type Clip } from "../shared/model";
import { optionLabel } from "./labels";

export function MotionTile({
  preset,
  label,
  onAdd,
}: {
  preset: Clip["preset"];
  label: string;
  onAdd: () => void;
}) {
  const [active, setActive] = useState(false);
  const project = useMemo(() => {
    const p = newProject();
    p.width = 640;
    p.height = 240;
    p.background = "#0d0d10";
    p.clips = [
      {
        ...makeClip(p, "text", "titles"),
        preset,
        text: label,
        x: 20,
        y: 50,
        width: 600,
        height: 140,
        fontSize: 56,
        duration: 90,
      },
    ];
    return p;
  }, [preset, label]);
  const preview = () => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      setActive(true);
  };
  return (
    <button
      className={"motion-tile motion-" + preset}
      aria-label={`Add ${preset.replaceAll("-", " ")} title`}
      onClick={onAdd}
      onMouseEnter={preview}
      onMouseLeave={() => setActive(false)}
      onFocus={preview}
      onBlur={() => setActive(false)}
    >
      <div className="motion-demo">
        {active ? (
          <Player
            component={Film}
            inputProps={{ project, mediaBase: "", preview: true }}
            durationInFrames={90}
            compositionWidth={640}
            compositionHeight={240}
            fps={30}
            autoPlay
            loop
            controls={false}
            clickToPlay={false}
            style={{ width: "100%", height: "100%", pointerEvents: "none" }}
          />
        ) : (
          label
        )}
      </div>
      <span>{optionLabel(preset)}</span>
    </button>
  );
}
