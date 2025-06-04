import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";

/*
    -> Running the app:
        FileGraph.jsx -> npm run dev
        file-graph-server-py -> uvicorn file_graph_server:app --reload

    -> Recreating Python venvironment:
        python -m venv venv
        venv\Scripts\activate
        pip install -r requirements.txt
    
    -> Run the server:
        run the server uvicorn command in the terminal:
        uvicorn file_graph_server:app --reload
        
        python file_graph_server.py
        


TO DO:

- [ ] Add a button to toggle between "show all files" and "show only children" 
      //this will only display the children of the selected node and the node itself
- [ ] Add a button to toggle between show files and show folders
      //this will allow the user to see only the folders or files in the graph sized with the aggregate size of the files in the folder
- [ ] add a slider for adjesting size of nodes
      //this will allow the user to adjust the size of all of the nodes in the graph
      //this will be a global setting and not a per node setting and will be a multiplier for the size of the node


- [ ] add file statistics menu
- [ ] create modal for file statistics as well as errors
- [ ] fix population of nodes from top left corner
- [ ] fix websocket/ server connection error handling
- [ ] add buttons for using the tool from react rather then the cli

*/

export default function FileGraph() {
  const svgRef = useRef(null);
  const [nodes, setNodes] = useState([]);
  const [rawFiles, setRawFiles] = useState({});
  const [outputMessage, setOutputMessage] = useState("");
  const [showLabels, setShowLabels] = useState(true);
  const [selectedNode, setSelectedNode] = useState(null);
  // force parameters
  const [linkDistance, setLinkDistance] = useState(50);
  const [chargeStrength, setChargeStrength] = useState(-100);
  const [collidePadding, setCollidePadding] = useState(2);
  const [centerStrength, setCenterStrength] = useState(0.1);

  const [availableFolders, setAvailableFolders] = useState([]);
  const [rootDir, setRootDir] = useState("");

  useEffect(() => {
    fetch("http://localhost:8000/folders")
      .then((r) => r.json())
      .then((d) => {
        setAvailableFolders(d.folders);
        if (d.folders.length) {
          setRootDir(d.folders[0]);
        }
      })
      .catch(() => setOutputMessage("Failed to fetch folders"));
  }, []);

  useEffect(() => {
    if (!rootDir) return;
    const ws = new WebSocket("ws://localhost:8000/ws");
    ws.onopen = () => {
      setOutputMessage("WebSocket connected");
      ws.send(
        JSON.stringify({
          type: "start",
          root: rootDir,
        }),
      );
    };
    ws.onmessage = (e) => {
      const info = JSON.parse(e.data);
      if (info.error) {
        setOutputMessage(`Error: ${info.error}`);
        return;
      }
      setRawFiles((prev) => ({ ...prev, [info.path]: info }));
      setNodes((prev) => [...prev, info]);
    };
    ws.onerror = () => setOutputMessage("WebSocket error");
    ws.onclose = (ev) =>
      setOutputMessage(ev.wasClean ? "WebSocket closed" : "WebSocket lost");
    return () => ws.close();
  }, [rootDir]);

  /*─────────────────────────────────────────────────────────
   * 2. Build graph + render with D3
   *────────────────────────────────────────────────────────*/
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || nodes.length === 0) return;

    /*—— Setup ——*/
    const W = svgEl.clientWidth,
      H = svgEl.clientHeight;
    const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${H}`);
    svg.selectAll("*").remove();
    const gRoot = svg.append("g"); // zoom container root
    svg.call(
      d3
        .zoom()
        .scaleExtent([0.1, 8])
        .on("zoom", (e) => gRoot.attr("transform", e.transform)),
    );

    /*—— Helpers ——*/
    const norm = (p) => p.replace(/\\/g, "/");
    const firstPath = nodes[0].path;
    const parts = firstPath.split(/[\\\/]/);
    const rootFolder = parts[parts.length - 2] || parts[0];
    const rootAbs = firstPath.slice(
      0,
      firstPath.lastIndexOf(rootFolder) + rootFolder.length,
    );
    const rootId = "dir:root";

    const calcFolderSize = (relDir) => {
      if (relDir === ".") {
        return Object.values(rawFiles).reduce((s, f) => s + f.size, 0);
      }
      const prefix = relDir + "/";
      return Object.values(rawFiles).reduce((sum, f) => {
        const p = f.parent_dir.replace(/\\/g, "/");
        return p === relDir || p.startsWith(prefix) ? sum + f.size : sum;
      }, 0);
    };

    /*—— Directory nodes ——*/
    const dirSet = new Set();
    nodes.forEach((f) => {
      const rel = norm(f.parent_dir);
      if (rel !== ".")
        rel.split("/").reduce((acc, seg) => {
          const p = acc ? `${acc}/${seg}` : seg;
          dirSet.add(p);
          return p;
        }, "");
    });
    const dirNodes = [
      {
        id: rootId,
        type: "dir",
        name: rootFolder,
        abs: rootAbs,
        rel: ".",
        parent: rootAbs,
      },
    ];
    dirSet.forEach((rel) => {
      const abs = `${rootAbs}/${rel}`;
      const segs = rel.split("/");
      const name = segs.pop();
      const parentAbs = segs.length ? `${rootAbs}/${segs.join("/")}` : rootAbs;
      dirNodes.push({
        id: `dir:${rel}`,
        type: "dir",
        name,
        abs,
        rel,
        parent: parentAbs,
      });
    });

    /*—— File nodes ——*/
    const fileNodes = nodes.map((f) => {
      const relDir = norm(f.parent_dir);
      return {
        id: `file:${f.path}`,
        type: "file",
        name: f.path
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^/.]+$/, ""),
        size: f.size,
        path: f.path,
        parent: relDir === "." ? rootId : `dir:${relDir}`,
        abs: f.path,
        parentDir: relDir === "." ? rootAbs : `${rootAbs}/${relDir}`,
        ...f,
      };
    });

    /*—— Links ——*/
    const dirLinks = [...dirSet].map((rel) => {
      const segs = rel.split("/");
      const parentRel = segs.length > 1 ? segs.slice(0, -1).join("/") : ".";
      return {
        source: parentRel === "." ? rootId : `dir:${parentRel}`,
        target: `dir:${rel}`,
      };
    });
    const fileLinks = fileNodes.map((f) => ({
      source: f.parent,
      target: f.id,
    }));
    const links = [...dirLinks, ...fileLinks];

    /*—— Scales ——*/
    const sizeScale = d3
      .scaleSqrt()
      .domain(d3.extent(fileNodes, (d) => d.size))
      .range([4, 20]);
    const color = d3.scaleOrdinal(["#1f77b4", "#2ca02c"]);

    /*—— Draw links ——*/
    gRoot
      .append("g")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 1);

    /*—— Draw nodes ——*/
    const allNodes = [...dirNodes, ...fileNodes];
    const nodeG = gRoot
      .append("g")
      .selectAll("g")
      .data(allNodes)
      .join("g")
      .call(
        d3.drag().on("start", dragStart).on("drag", dragged).on("end", dragEnd),
      )
      .style("cursor", "pointer")
      .on("click", (_, d) => {
        if (d.type === "file") {
          setSelectedNode({ ...rawFiles[d.path], type: "file" });
        } else {
          // total size of *all descendant* files
          const bytes = Object.values(rawFiles)
            .filter((f) => f.parent_dir === d.rel)
            .reduce((sum, f) => sum + f.size, 0);
          setSelectedNode({
            type: "dir",
            abs: d.abs,
            parent: d.parent,
            totalSize: bytes,
            totalSize: calcFolderSize(d.rel),
          });
        }
      });

    nodeG
      .append("circle")
      .attr("r", (d) => (d.type === "dir" ? 12 : sizeScale(d.size)))
      .attr("fill", (d) => (d.type === "dir" ? color(0) : color(1)));
    nodeG
      .append("text")
      .attr("y", (d) => (d.type === "dir" ? -16 : sizeScale(d.size) + 12))
      .attr("text-anchor", "middle")
      .attr("font-size", 10)
      .style("display", showLabels ? null : "none")
      .text((d) => {
        const t = d.type === "dir" ? d.name + "/" : d.name;
        return t.length > 12 ? t.slice(0, 12) + "…" : t;
      });

    /*—— Simulation ——*/
    const sim = d3
      .forceSimulation(allNodes)
      .force(
        "link",
        d3
          .forceLink(links)
          .id((d) => d.id)
          .distance(linkDistance),
      )
      .force("charge", d3.forceManyBody().strength(chargeStrength))
      .force("center", d3.forceCenter(W / 2, H / 2).strength(centerStrength))
      .force(
        "collide",
        d3
          .forceCollide()
          .radius((d) =>
            d.type === "dir" ? 14 : sizeScale(d.size) + collidePadding,
          ),
      );
    sim.on("tick", () => {
      gRoot
        .selectAll("line")
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);
      nodeG.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });
    function dragStart(evt, d) {
      if (!evt.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }
    function dragged(evt, d) {
      d.fx = evt.x;
      d.fy = evt.y;
    }
    function dragEnd(evt, d) {
      if (!evt.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }
    return () => sim.stop();
  }, [
    nodes,
    showLabels,
    linkDistance,
    chargeStrength,
    collidePadding,
    centerStrength,
    rawFiles,
  ]);

  /*─────────────────────────────────────────────────────────
   * 3. UI (toolbar + tooltip)
   *────────────────────────────────────────────────────────*/
  return (
    <>
      {/* Toolbar with buttons and sliders */}
      <div style={{ padding: "8px", background: "#eee" }}>
        <label style={{ marginRight: "1rem" }}>
          Folder:
          <select
            value={rootDir}
            onChange={(e) => {
              setNodes([]);
              setRawFiles({});
              setRootDir(e.target.value);
            }}
          >
            {availableFolders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <button disabled>Button1</button>
        <button disabled>Button2</button>
        <button disabled>Button3</button>
        <button onClick={() => setShowLabels((v) => !v)}>
          {showLabels ? "Hide labels" : "Show labels"}
        </button>
        <div style={{ marginTop: "8px" }}>
          <label>
            Link Distance: {linkDistance}
            <input
              type="range"
              min="10"
              max="200"
              value={linkDistance}
              onChange={(e) => setLinkDistance(+e.target.value)}
            />
          </label>
          <label style={{ marginLeft: "1rem" }}>
            Charge: {chargeStrength}
            <input
              type="range"
              min="-500"
              max="0"
              value={chargeStrength}
              onChange={(e) => setChargeStrength(+e.target.value)}
            />
          </label>
          <label style={{ marginLeft: "1rem" }}>
            Collide Pad: {collidePadding}
            <input
              type="range"
              min="0"
              max="50"
              value={collidePadding}
              onChange={(e) => setCollidePadding(+e.target.value)}
            />
          </label>
          <label style={{ marginLeft: "1rem" }}>
            Center Str: {centerStrength}
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={centerStrength}
              onChange={(e) => setCenterStrength(+e.target.value)}
            />
          </label>
        </div>
      </div>
      {/* Tooltip panel */}
      <div
        style={{
          position: "absolute",
          top: 72,
          right: 8,
          width: 700,
          background: "#fff",
          border: "1px solid #ccc",
          padding: "8px",
          maxHeight: "calc(100vh - 80px)",
          overflowY: "auto",
          fontSize: 12,
        }}
      >
        {selectedNode ? (
          selectedNode.type === "file" ? (
            <>
              <h4 style={{ wordBreak: "break-all", margin: 0 }}>
                {selectedNode.path}
              </h4>
              <p>
                <strong>Folder:</strong> {selectedNode.parent_dir}
              </p>
              <p>
                <strong>Type:</strong> {selectedNode.file_type}
              </p>
              <p>
                <strong>Size:</strong> {selectedNode.size} bytes
              </p>
              <p>
                <strong>Created:</strong>{" "}
                {new Date(selectedNode.created).toLocaleString()}
              </p>
              <p>
                <strong>Accessed:</strong>{" "}
                {new Date(selectedNode.accessed).toLocaleString()}
              </p>
            </>
          ) : (
            <>
              <h4 style={{ wordBreak: "break-all", margin: 0 }}>
                {selectedNode.abs}
              </h4>
              <p>
                <strong>Parent:</strong> {selectedNode.parent}
              </p>
              <p>
                <strong>Total size of files in folder:</strong>{" "}
                {selectedNode.totalSize} bytes
              </p>
            </>
          )
        ) : (
          <em>Click a node for details</em>
        )}
      </div>
      <svg
        ref={svgRef}
        style={{ width: "100%", height: "90vh", background: "#f9f9f9" }}
      />
      <div style={{ padding: "4px 8px" }}>{outputMessage}</div>
    </>
  );
}
