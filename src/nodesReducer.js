import {
  deleteConnection as deleteConnectionClient,
  deleteConnectionsByNodeId as deleteConnectionsByNodeIdClient
} from "./connectionCalculator";
import { checkForCircularNodes } from "./utilities";
import {nanoid} from "nanoid/non-secure";

let deleteConnection = () => {}
let deleteConnectionsByNodeId = () => {}

if (global.window !== undefined) {
  deleteConnection = deleteConnectionClient
  deleteConnectionsByNodeId = deleteConnectionsByNodeIdClient
}

const addConnection = (nodes, input, output, portTypes) => {
  const newNodes = {
    ...nodes,
    [input.nodeId]: {
      ...nodes[input.nodeId],
      connections: {
        ...nodes[input.nodeId].connections,
        inputs: {
          ...nodes[input.nodeId].connections.inputs,
          [input.portName]: [
            ...(nodes[input.nodeId].connections.inputs[input.portName] || []),
            {
              nodeId: output.nodeId,
              portName: output.portName
            }
          ]
        }
      }
    },
    [output.nodeId]: {
      ...nodes[output.nodeId],
      connections: {
        ...nodes[output.nodeId].connections,
        outputs: {
          ...nodes[output.nodeId].connections.outputs,
          [output.portName]: [
            ...(nodes[output.nodeId].connections.outputs[output.portName] ||
              []),
            {
              nodeId: input.nodeId,
              portName: input.portName
            }
          ]
        }
      }
    }
  };
  return newNodes;
};

const removeConnection = (nodes, input, output) => {
  const inputNode = nodes[input.nodeId];
  const {
    [input.portName]: removedInputPort,
    ...newInputNodeConnectionsInputs
  } = inputNode.connections.inputs;
  const newInputNode = {
    ...inputNode,
    connections: {
      ...inputNode.connections,
      inputs: newInputNodeConnectionsInputs
    }
  };

  const outputNode = nodes[output.nodeId];
  const filteredOutputNodes = outputNode.connections.outputs[
    output.portName
  ].filter(cnx => {
    return cnx.nodeId === input.nodeId ? cnx.portName !== input.portName : true;
  });
  const newOutputNode = {
    ...outputNode,
    connections: {
      ...outputNode.connections,
      outputs: {
        ...outputNode.connections.outputs,
        [output.portName]: filteredOutputNodes
      }
    }
  };

  return {
    ...nodes,
    [input.nodeId]: newInputNode,
    [output.nodeId]: newOutputNode
  };
};

const getFilteredTransputs = (transputs, nodeId) =>
  Object.entries(transputs).reduce((obj, [portName, transput]) => {
    const newTransputs = transput.filter(t => t.nodeId !== nodeId);
    if (newTransputs.length) {
      obj[portName] = newTransputs;
    }
    return obj;
  }, {});

const removeConnections = (connections, nodeId) => ({
  inputs: getFilteredTransputs(connections.inputs, nodeId),
  outputs: getFilteredTransputs(connections.outputs, nodeId)
});

const removeNode = (startNodes, nodeId) => {
  let { [nodeId]: deletedNode, ...nodes } = startNodes;
  nodes = Object.values(nodes).reduce((obj, node) => {
    obj[node.id] = {
      ...node,
      connections: removeConnections(node.connections, nodeId)
    };

    return obj;
  }, {});
  deleteConnectionsByNodeId(nodeId);
  return nodes;
};

const reconcileNodes = (initialNodes, nodeTypes, portTypes, context) => {
  let nodes = { ...initialNodes };

  // Delete extraneous nodes
  let nodesToDelete = Object.values(nodes)
    .map(node => (!nodeTypes[node.type] ? node.id : undefined))
    .filter(x => x);

  nodesToDelete.forEach(nodeId => {
    nodes = nodesReducer(
      nodes,
      {
        type: "REMOVE_NODE",
        nodeId
      },
      { nodeTypes, portTypes, context }
    );
  });

  // Reconcile input data for each node
  let reconciledNodes = Object.values(nodes).reduce((nodesObj, node) => {
    const nodeType = nodeTypes[node.type];
    const defaultInputData = getDefaultData({ node, nodeType, portTypes, context });
    const currentInputData = Object.entries(node.inputData).reduce(
      (dataObj, [key, data]) => {
        if (defaultInputData[key] !== undefined) {
          dataObj[key] = data;
        }
        return dataObj;
      },
      {}
    );
    const newInputData = {
      ...defaultInputData,
      ...currentInputData
    };
    nodesObj[node.id] = {
      ...node,
      inputData: newInputData
    };
    return nodesObj;
  }, {});

  // Reconcile node attributes for each node
  reconciledNodes = Object.values(reconciledNodes).reduce((nodesObj, node) => {
    let newNode = { ...node };
    const nodeType = nodeTypes[node.type];
    if (nodeType.root !== node.root) {
      if (nodeType.root && !node.root) {
        newNode.root = nodeType.root;
      } else if (!nodeType.root && node.root) {
        delete newNode.root;
      }
    }
    nodesObj[node.id] = newNode;
    return nodesObj;
  }, {});

  return reconciledNodes;
};

export const getInitialNodes = (
  initialNodes = {},
  defaultNodes = [],
  nodeTypes,
  portTypes,
  context
) => {
  const reconciledNodes = reconcileNodes(initialNodes, nodeTypes, portTypes, context);

  return {
    ...reconciledNodes,
    ...defaultNodes.reduce((nodes, dNode, i) => {
      const nodeNotAdded = !Object.values(initialNodes).find(
        n => n.type === dNode.type
      );
      if (nodeNotAdded) {
        nodes = nodesReducer(
          nodes,
          {
            type: "ADD_NODE",
            id: `default-${i}`,
            defaultNode: true,
            x: dNode.x || 0,
            y: dNode.y || 0,
            nodeType: dNode.type
          },
          { nodeTypes, portTypes, context }
        );
      }
      return nodes;
    }, {})
  };
};

const getDefaultData = ({ node, nodeType, portTypes, context }) => {
  const inputs = Array.isArray(nodeType.inputs)
    ? nodeType.inputs
    : nodeType.inputs(node.inputData, node.connections, context);
  return inputs.reduce((obj, input) => {
    const inputType = portTypes[input.type];
    obj[input.name || inputType.name] = (
      input.controls ||
      inputType.controls ||
      []
    ).reduce((obj2, control) => {
      obj2[control.name] = control.defaultValue;
      return obj2;
    }, {});
    return obj;
  }, {});
};

const nodesReducer = (
  nodes,
  action = {},
  { nodeTypes, portTypes, cache, circularBehavior, context },
  dispatchToasts,
  broadcast = () => {}
) => {
  broadcast = action.broadcast || broadcast
  switch (action.type) {
    case "ADD_CONNECTION": {
      const { input, output } = action;
      const inputIsNotConnected = !nodes[input.nodeId].connections.inputs[
        input.portName
      ];
      if (inputIsNotConnected) {
        const allowCircular = circularBehavior === "warn" || circularBehavior === "allow"
        const newNodes = addConnection(nodes, input, output, portTypes);
        const isCircular = checkForCircularNodes(newNodes, output.nodeId);
        if (isCircular && !allowCircular) {
          dispatchToasts({
            type: "ADD_TOAST",
            title: "Unable to connect",
            message: "Connecting these nodes would result in an infinite loop.",
            toastType: "warning",
            duration: 5000
          });
          return nodes;
        } else {
          if(isCircular && circularBehavior === "warn"){
            dispatchToasts({
              type: "ADD_TOAST",
              title: "Circular Connection Detected",
              message: "Connecting these nodes has created an infinite loop.",
              toastType: "warning",
              duration: 5000
            });
          }
          broadcast(action);
          return newNodes;
        }
      } else return nodes;
    }

    case "REMOVE_CONNECTION": {
      const { input, output } = action;
      const id =
        output.nodeId + output.portName + input.nodeId + input.portName;
      delete cache.current.connections[id];
      deleteConnection({ id });
      broadcast(action);
      return removeConnection(nodes, input, output);
    }

    case "DESTROY_TRANSPUT": {
      const { transput, transputType } = action;
      const portId = transput.nodeId + transput.portName + transputType;
      delete cache.current.ports[portId];

      const cnxType = transputType === 'input' ? 'inputs' : 'outputs';
      const connections = nodes[transput.nodeId].connections[cnxType][transput.portName];
      if (!connections || !connections.length) return nodes;

      broadcast(action);
      return connections.reduce((nodes, cnx) => {
        const [input, output] = transputType === 'input' ? [transput, cnx] : [cnx, transput];
        const id = output.nodeId + output.portName + input.nodeId + input.portName;
        delete cache.current.connections[id];
        deleteConnection({ id });
        return removeConnection(nodes, input, output);
      }, nodes);
    }

    case "ADD_NODE": {
      const { x, y, nodeType, id, defaultNode } = action;
      const newNodeId = id || nanoid(10);
      const newNode = {
        id: newNodeId,
        x,
        y,
        type: nodeType,
        width: nodeTypes[nodeType].initialWidth || 200,
        connections: {
          inputs: {},
          outputs: {}
        },
        inputData: {}
      };
      newNode.inputData = getDefaultData({
        node: newNode,
        nodeType: nodeTypes[nodeType],
        portTypes,
        context
      });
      if (defaultNode) {
        newNode.defaultNode = true;
      }
      if (nodeTypes[nodeType].root) {
        newNode.root = true;
      }
      const newNodes = {
        ...nodes,
        [newNodeId]: newNode
      };
      broadcast({...action, id: newNodeId, validNodes: Object.keys(newNodes)});
      return newNodes;
    }

    case "REMOVE_NODE": {
      const { nodeId } = action;
      broadcast(action);
      return removeNode(nodes, nodeId);
    }

    case "HYDRATE_DEFAULT_NODES": {
      const newNodes = { ...nodes };
      for (const key in newNodes) {
        if (newNodes[key].defaultNode) {
          const newNodeId = nanoid(10);
          const { id, defaultNode, ...node } = newNodes[key];
          newNodes[newNodeId] = {...node, id: newNodeId };
          delete newNodes[key];
        }
      }
      broadcast(action);
      return newNodes;
    }

    case "SET_PORT_DATA": {
      const { nodeId, portName, controlName, data, setValue } = action;
      let newData = {
        ...nodes[nodeId].inputData,
        [portName]: {
          ...nodes[nodeId].inputData[portName],
          [controlName]: data
        }
      };
      if (setValue) {
        newData = setValue(newData, nodes[nodeId].inputData);
      }
      broadcast(action);
      return {
        ...nodes,
        [nodeId]: {
          ...nodes[nodeId],
          inputData: newData
        }
      };
    }

    case "SET_NODE_COORDINATES": {
      const { x, y, nodeId } = action;
      broadcast(action);
      return {
        ...nodes,
        [nodeId]: {
          ...nodes[nodeId],
          x,
          y
        }
      };
    }

    case "REDRAW_EVERYTHING": {
      action.nodes = action.nodes || { ...nodes };
      Object.values(nodes).forEach(node => deleteConnectionsByNodeId(node.id));
      // do not broadcast
      return getInitialNodes(action.nodes, [], nodeTypes, portTypes, context);
    }

    default:
      return nodes;
  }
};

export const connectNodesReducer = (reducer, environment, dispatchToasts, broadcast) => (
  state,
  action
) => reducer(state, action, environment, dispatchToasts, broadcast);

export default nodesReducer;
