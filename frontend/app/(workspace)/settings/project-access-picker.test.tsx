import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { chosenLabel, ProjectChecklist } from "./project-access-picker";

const projects = [
  { id: "a", label: "billing", repository: "gitlab.com/acme/billing" },
  { id: "b", label: "web", repository: "acme/web" },
];

test("the picker's label names the one project, counts several, and asks when none", () => {
  expect(chosenLabel(projects, [])).toBe("Choose projects");
  expect(chosenLabel(projects, ["b"])).toBe("web");
  expect(chosenLabel(projects, ["a", "b"])).toBe("2 projects");
});

test("the invitation's checklist offers every project with its repository, and says when there are none", () => {
  const html = renderToStaticMarkup(
    <ProjectChecklist projects={projects} chosen={["a"]} onChange={() => {}} />,
  );
  expect(html).toContain("billing");
  expect(html).toContain("gitlab.com/acme/billing");
  expect(html).toContain("acme/web");
  expect(
    renderToStaticMarkup(<ProjectChecklist projects={[]} chosen={[]} onChange={() => {}} />),
  ).toContain("This workspace has no projects yet.");
});
