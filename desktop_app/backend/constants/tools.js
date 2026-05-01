const TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file on disk with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Edit a file by replacing an exact string with new content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path." },
          old_str: { type: "string", description: "The exact string to find and replace." },
          new_str: { type: "string", description: "The replacement string." },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read and return the content of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_path",
      description: "Permanently delete a file or directory from disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute path to delete." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a file.",
      parameters: {
        type: "object",
        properties: {
          old_path: { type: "string", description: "Current file path." },
          new_path: { type: "string", description: "New file path." },
        },
        required: ["old_path", "new_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "Create a directory and any missing parents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to create." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory within the repo.",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Directory path, optional." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_terminal_command",
      description: "Run a shell command in the project directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute." },
        },
        required: ["command"],
      },
    },
  },
];

module.exports = { TOOLS };
