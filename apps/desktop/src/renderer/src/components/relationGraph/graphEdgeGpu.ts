import type { GraphView } from './graphLayout';
import type { RenderEdge } from './graphRender';
import type { BuiltGraph } from './types';

export const GPU_EDGE_THRESHOLD = 10000;
export const GPU_EDGE_CSS_PIXEL_THRESHOLD = 100000;
export function graphEdgePixelRatio(edgeCount: number, scale: number, dpr: number) {
  return edgeCount >= GPU_EDGE_CSS_PIXEL_THRESHOLD && scale < 1 ? Math.min(dpr, 1) : dpr;
}

const vertex = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in uvec2 endpoints;
layout(location=1) in float weight;
uniform sampler2D positions;
uniform vec2 viewport;
uniform vec2 pan;
uniform float scale;
uniform int selfIndex;
uniform int focusIndex;
uniform bool highlightedLayer;
uniform bool thinLayer;
out float distanceToLine;
flat out float halfWidth;
flat out vec4 color;
void main() {
  bool focused = int(endpoints.x) == focusIndex || int(endpoints.y) == focusIndex;
  if (!highlightedLayer && focusIndex >= 0 && focused) { gl_Position = vec4(2.,2.,0.,1.); return; }
  bool selfEdge = int(endpoints.x) == selfIndex || int(endpoints.y) == selfIndex;
  float width = highlightedLayer ? min(1. + weight * .5,4.) : selfEdge ? .5 : min(.6 + weight * .25,2.4);
  halfWidth = width * scale * .5;
  color = highlightedLayer ? vec4(0.,153./255.,1.,.55) : vec4(120./255.,140./255.,165./255.,selfEdge ? .07 : .18);
  if (thinLayer) {
    int endpoint = gl_VertexID == 0 ? int(endpoints.x) : int(endpoints.y);
    vec2 point = texelFetch(positions,ivec2(endpoint,0),0).xy * scale + pan;
    distanceToLine = 0.;
    gl_Position = vec4(point.x / viewport.x * 2. - 1., 1. - point.y / viewport.y * 2.,0.,1.);
    return;
  }
  vec2 source = texelFetch(positions, ivec2(int(endpoints.x),0), 0).xy * scale + pan;
  vec2 target = texelFetch(positions, ivec2(int(endpoints.y),0), 0).xy * scale + pan;
  vec2 delta = target - source;
  vec2 normal = vec2(-delta.y,delta.x) / max(length(delta),0.00001);
  const vec2 corners[6] = vec2[6](vec2(0.,-1.),vec2(1.,-1.),vec2(0.,1.),vec2(0.,1.),vec2(1.,-1.),vec2(1.,1.));
  vec2 corner = corners[gl_VertexID];
  distanceToLine = corner.y * (halfWidth + 1.);
  vec2 point = mix(source,target,corner.x) + normal * distanceToLine;
  gl_Position = vec4(point.x / viewport.x * 2. - 1., 1. - point.y / viewport.y * 2.,0.,1.);
}`;

const fragment = `#version 300 es
precision highp float;
in float distanceToLine;
flat in float halfWidth;
flat in vec4 color;
uniform bool thinLayer;
out vec4 outputColor;
void main() {
  float coverage = thinLayer ? min(1.,halfWidth * 2.) : clamp(min(halfWidth,distanceToLine + .5) - max(-halfWidth,distanceToLine - .5),0.,1.);
  float alpha = color.a * coverage;
  outputColor = vec4(color.rgb * alpha,alpha);
}`;

/** 完整边集一次上传，逐帧只更新节点坐标；不支持 WebGL 时交回原 Canvas。 */
export function createGraphEdgeGpu(graph: BuiltGraph, incident: Map<string, RenderEdge[]>) {
  if (graph.edges.length < GPU_EDGE_THRESHOLD) return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
  });
  if (!gl) return null;
  const buffers: WebGLBuffer[] = [];
  const arrays: WebGLVertexArrayObject[] = [];
  const program = gl.createProgram();
  const texture = gl.createTexture();
  let lost = false;
  canvas.addEventListener('webglcontextlost', () => {
    lost = true;
    canvas.hidden = true;
  });
  function dispose() {
    canvas.remove();
    for (const buffer of buffers) gl!.deleteBuffer(buffer);
    for (const array of arrays) gl!.deleteVertexArray(array);
    gl!.deleteTexture(texture);
    gl!.deleteProgram(program);
    gl!.getExtension('WEBGL_lose_context')?.loseContext();
  }
  try {
    if (!program || !texture) throw new Error('GPU 初始化失败');
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('GPU 着色器初始化失败');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`GPU 着色器编译失败：${message}`);
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('GPU 着色器链接失败');
    const activateProgram = gl.useProgram.bind(gl);
    activateProgram(program);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const viewport = uniform('viewport');
    const pan = uniform('pan');
    const scale = uniform('scale');
    const focusIndex = uniform('focusIndex');
    const active = uniform('highlightedLayer');
    const thinLayer = uniform('thinLayer');
    const indices = new Map(graph.nodes.map((node, i) => [node.id, i]));
    const nodeState = new Float32Array(graph.nodes.length * 2);
    gl.uniform1i(
      uniform('selfIndex'),
      graph.nodes.findIndex((node) => node.kind === 'self'),
    );
    gl.uniform1i(uniform('positions'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, graph.nodes.length, 1, 0, gl.RG, gl.FLOAT, nodeState);

    function geometry(edges: RenderEdge[] | BuiltGraph['edges']) {
      const array = gl!.createVertexArray();
      const endpointBuffer = gl!.createBuffer();
      const weightBuffer = gl!.createBuffer();
      if (array) arrays.push(array);
      if (endpointBuffer) buffers.push(endpointBuffer);
      if (weightBuffer) buffers.push(weightBuffer);
      if (!array || !endpointBuffer || !weightBuffer) throw new Error('GPU 连线缓冲初始化失败');
      gl!.bindVertexArray(array);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, endpointBuffer);
      gl!.enableVertexAttribArray(0);
      gl!.vertexAttribIPointer(0, 2, gl!.UNSIGNED_INT, 0, 0);
      gl!.vertexAttribDivisor(0, 1);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, weightBuffer);
      gl!.enableVertexAttribArray(1);
      gl!.vertexAttribPointer(1, 1, gl!.FLOAT, false, 0, 0);
      gl!.vertexAttribDivisor(1, 1);
      return {
        array,
        endpointBuffer,
        weightBuffer,
        upload(items: typeof edges) {
          const endpoints = new Uint32Array(items.length * 2);
          const weights = new Float32Array(items.length);
          items.forEach((edge, i) => {
            const id = (value: string | RenderEdge['source']) =>
              typeof value === 'string' ? value : value.id;
            endpoints[i * 2] = indices.get(id(edge.source))!;
            endpoints[i * 2 + 1] = indices.get(id(edge.target))!;
            weights[i] = edge.weight;
          });
          gl!.bindBuffer(gl!.ARRAY_BUFFER, endpointBuffer);
          gl!.bufferData(gl!.ARRAY_BUFFER, endpoints, gl!.STATIC_DRAW);
          gl!.bindBuffer(gl!.ARRAY_BUFFER, weightBuffer);
          gl!.bufferData(gl!.ARRAY_BUFFER, weights, gl!.STATIC_DRAW);
        },
      };
    }
    const base = geometry(graph.edges);
    base.upload(graph.edges);
    const highlighted = geometry([]);
    let previousFocus: string | null | undefined;
    let highlightedCount = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    return {
      canvas,
      draw(view: GraphView, width: number, height: number, dpr: number, focus: string | null) {
        if (lost || gl.isContextLost()) {
          canvas.hidden = true;
          return false;
        }
        const w = Math.max(1, Math.round(width * dpr));
        const h = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, w, h);
        gl.clear(gl.COLOR_BUFFER_BIT);
        graph.nodes.forEach((node, i) => {
          nodeState[i * 2] = node.x;
          nodeState[i * 2 + 1] = node.y;
        });
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, graph.nodes.length, 1, gl.RG, gl.FLOAT, nodeState);
        gl.uniform2f(viewport, w, h);
        gl.uniform2f(pan, view.x * dpr, view.y * dpr);
        gl.uniform1f(scale, view.scale * dpr);
        gl.uniform1i(focusIndex, focus === null ? -1 : (indices.get(focus) ?? -1));
        gl.uniform1i(active, 0);
        const thin = 2.4 * view.scale * dpr <= 1;
        gl.uniform1i(thinLayer, thin ? 1 : 0);
        gl.bindVertexArray(base.array);
        gl.drawArraysInstanced(thin ? gl.LINES : gl.TRIANGLES, 0, thin ? 2 : 6, graph.edges.length);
        if (focus !== previousFocus) {
          const edges = focus === null ? [] : (incident.get(focus) ?? []);
          highlighted.upload(edges);
          highlightedCount = edges.length;
          previousFocus = focus;
        }
        if (highlightedCount) {
          gl.uniform1i(active, 1);
          gl.uniform1i(thinLayer, 0);
          gl.bindVertexArray(highlighted.array);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, highlightedCount);
        }
        return true;
      },
      dispose,
    };
  } catch (error) {
    console.warn('群交集 GPU 绘制不可用，回退 Canvas', error);
    dispose();
    return null;
  }
}
