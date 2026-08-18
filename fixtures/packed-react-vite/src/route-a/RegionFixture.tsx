import { RegionButtonA } from "./RegionButtonA";
import { RegionButtonB } from "./RegionButtonB";
import { RegionOnly } from "./RegionOnly";

export function RegionFixture() {
  return <div id="region-fixture" style={{ position: "relative", width: 420, height: 260 }}>
    {Array.from({ length: 70 }, (_, index) => (
      <div className="wrapper" key={index} style={{ position: "absolute", inset: 0 }} />
    ))}
    <div style={{ position: "absolute", left: 20, top: 20 }}><RegionButtonA /></div>
    <div style={{ position: "absolute", left: 200, top: 120 }}><RegionButtonB /></div>
    <div style={{ position: "absolute", left: 300, top: 40 }}><RegionOnly /></div>
  </div>;
}
