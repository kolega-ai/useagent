import { expect, test } from "bun:test";
import { managesPeople, railRoutesFor } from "./workspace-role";

const routes = [
  { id: "new" },
  { id: "dashboard" },
  { id: "bots" },
  { id: "customize" },
  { id: "library" },
];

test("a project member's rail is only New thread; everyone else keeps every row", () => {
  expect(railRoutesFor("project_member", routes).map((route) => route.id)).toEqual(["new"]);
  for (const role of ["owner", "admin", "member", null, undefined] as const) {
    expect(railRoutesFor(role, routes).map((route) => route.id)).toEqual([
      "new",
      "dashboard",
      "bots",
      "customize",
      "library",
    ]);
  }
});

test("only owners and admins manage a project's people", () => {
  expect([managesPeople("owner"), managesPeople("admin")]).toEqual([true, true]);
  expect([
    managesPeople("member"),
    managesPeople("project_member"),
    managesPeople(null),
    managesPeople(undefined),
  ]).toEqual([false, false, false, false]);
});
