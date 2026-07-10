return {
  {
    "github/copilot.vim",
    url = "https://github.com/github/copilot.vim.git",
    lazy = false,
    config = function()
      -- Disable default mappings
      -- vim.g.copilot_no_tab_map = true
      
      -- Set up custom mappings
      -- vim.api.nvim_set_keymap("i", "<C-J>", 'copilot#Accept("<CR>")', { silent = true, expr = true })
      -- vim.g.copilot_assume_mapped = true
    end,
  }
}
