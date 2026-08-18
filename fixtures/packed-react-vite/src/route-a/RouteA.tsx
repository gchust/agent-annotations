import { RegionFixture } from "./RegionFixture";

export function RouteA() {
  return <main>
    <h1>Route A</h1>
    <button id="shared-target" data-route="a">Shared target</button>
    <RegionFixture />
  </main>;
}
