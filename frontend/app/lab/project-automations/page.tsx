"use client";

import { useState } from "react";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { memberOf, PEOPLE, type Person, scopeOf, type Viewer } from "./fixtures";
import { MockAutomationsPage, MockEditor, MockSidebar } from "./panels";
import { MockProjectPage, MockTeam } from "./team-panels";

type Screen = "automations" | "project" | "editor" | "team";

/** Mockup of automations tied to projects and project-scoped members, on real components.
 *  The team is shared state: change Alex's projects or role and every screen follows. */
export default function ProjectAutomationsLab() {
  const [viewer, setViewer] = useState<Viewer>("admin");
  const [screen, setScreen] = useState<Screen>("automations");
  const [people, setPeople] = useState<readonly Person[]>(PEOPLE);
  const [teamFrom, setTeamFrom] = useState<"team" | "project">("team");
  const shown: Screen = viewer === "member" && screen === "team" ? "automations" : screen;
  // Remount the stateful screens when Alex's access changes, so they show it.
  const access = `${viewer}:${memberOf(people)?.role}:${scopeOf(memberOf(people)).join(",")}`;
  return (
    <main className="flex h-screen flex-col bg-background-full text-text-primary">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-button-default px-4 py-2.5">
        <p className="text-body-2-medium text-text-primary">Project automations mockup</p>
        <SegmentedControl
          aria-label="Viewing as"
          selectedKeys={[viewer]}
          onSelectionChange={(keys) => {
            const next = [...(keys as Set<string>)][0];
            if (next) setViewer(next as Viewer);
          }}
        >
          <SegmentedControlItem id="admin">Admin</SegmentedControlItem>
          <SegmentedControlItem id="member">Project member</SegmentedControlItem>
        </SegmentedControl>
        <SegmentedControl
          aria-label="Screen"
          selectedKeys={[shown]}
          onSelectionChange={(keys) => {
            const next = [...(keys as Set<string>)][0];
            if (next) setScreen(next as Screen);
          }}
        >
          <SegmentedControlItem id="automations">All automations</SegmentedControlItem>
          <SegmentedControlItem id="project">Project page</SegmentedControlItem>
          <SegmentedControlItem id="editor">New automation</SegmentedControlItem>
          {viewer === "admin" ? <SegmentedControlItem id="team">Team</SegmentedControlItem> : null}
        </SegmentedControl>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-border-button-default bg-sidebar p-2">
          <MockSidebar key={access} viewer={viewer} people={people} />
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {shown === "automations" ? (
            <MockAutomationsPage
              key={access}
              viewer={viewer}
              people={people}
              onCreate={() => setScreen("editor")}
            />
          ) : null}
          {shown === "project" ? (
            <MockProjectPage
              viewer={viewer}
              people={people}
              setPeople={setPeople}
              onAddPeople={() => {
                setTeamFrom("project");
                setScreen("team");
              }}
            />
          ) : null}
          {shown === "editor" ? <MockEditor key={access} viewer={viewer} people={people} /> : null}
          {shown === "team" ? (
            <MockTeam people={people} setPeople={setPeople} from={teamFrom} setFrom={setTeamFrom} />
          ) : null}
        </div>
      </div>
    </main>
  );
}
