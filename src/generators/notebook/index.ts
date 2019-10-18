// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { ISanitizer } from '@jupyterlab/apputils';
import { CodeCell, CodeCellModel, MarkdownCell, Cell } from '@jupyterlab/cells';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { Registry } from '../../registry';
import { TableOfContents } from '../../toc';
import { isMarkdown } from '../../utils/is_markdown';
import { isDOM } from '../../utils/is_dom';
import { INotebookHeading } from '../../utils/headings';
import { INumberingDictionary } from '../../utils/numbering_dictionary';
import { OptionsManager } from './options_manager';
import { getCodeCellHeading } from './get_code_cell_heading';
import { isHeadingFiltered } from './is_heading_filtered';
import { getLastHeadingLevel } from './get_last_heading_level';
import { getMarkdownHeading } from './get_markdown_heading';
import { getRenderedHTMLHeading } from './get_rendered_html_heading';
import { appendHeading } from './append_heading';
import { render } from './render';
import { toolbar } from './toolbar_generator';

/**
 * Create a TOC generator for notebooks.
 *
 * @param tracker: A notebook tracker.
 *
 * @returns A TOC generator that can parse notebooks.
 */
export function createNotebookGenerator(
  tracker: INotebookTracker,
  sanitizer: ISanitizer,
  widget: TableOfContents
): Registry.IGenerator<NotebookPanel> {
  const options = new OptionsManager(widget, tracker, {
    numbering: false,
    sanitizer: sanitizer
  });
  return {
    tracker,
    usesLatex: true,
    options: options,
    toolbarGenerator: () => {
      return toolbar(options, tracker);
    },
    itemRenderer: (item: INotebookHeading) => {
      return render(options, tracker, item);
    },
    generate: panel => {
      let headings: INotebookHeading[] = [];
      let numberingDict: INumberingDictionary = {};
      let collapseLevel = -1;
      // Keep track of the previous heading, so it can be
      // marked as having a child if one is discovered
      let prevHeading: INotebookHeading | null = null;
      // Iterate through the cells in the notebook, generating their headings
      for (let i = 0; i < panel.content.widgets.length; i++) {
        let cell: Cell = panel.content.widgets[i];
        let collapsed = cell.model.metadata.get('toc-hr-collapsed') as boolean;
        collapsed = collapsed !== undefined ? collapsed : false;
        let model = cell.model;
        if (model.type === 'code') {
          // Code is shown by default, overridden by previously saved settings
          if (!widget || (widget && options.showCode)) {
            // Generate the heading and add to headings if appropriate
            let executionCountNumber = (cell as CodeCell).model
              .executionCount as number | null;
            let executionCount =
              executionCountNumber !== null
                ? '[' + executionCountNumber + ']: '
                : '[ ]: ';
            let text = (model as CodeCellModel).value.text;
            const onClickFactory = (line: number) => {
              return () => {
                panel.content.activeCellIndex = i;
                cell.node.scrollIntoView();
              };
            };
            let lastLevel = getLastHeadingLevel(headings);
            let renderedHeading = getCodeCellHeading(
              text,
              onClickFactory,
              executionCount,
              lastLevel,
              cell
            );
            [headings, prevHeading] = Private.addMDOrCode(
              headings,
              renderedHeading,
              prevHeading,
              collapseLevel,
              options.filtered
            );
          }
          // Iterate over the code cell outputs to check for MD/HTML
          for (let j = 0; j < (model as CodeCellModel).outputs.length; j++) {
            const outputModel = (model as CodeCellModel).outputs.get(j);
            const dataTypes = Object.keys(outputModel.data);
            const htmlData = dataTypes.filter(t => isMarkdown(t) || isDOM(t));
            if (!htmlData.length) {
              continue;
            }
            // If MD/HTML generate the heading and add to headings if applicable
            const outputWidget = (cell as CodeCell).outputArea.widgets[j];
            const onClickFactory = (el: Element) => {
              return () => {
                panel.content.activeCellIndex = i;
                panel.content.mode = 'command';
                el.scrollIntoView();
              };
            };
            let lastLevel = getLastHeadingLevel(headings);
            let numbering = options.numbering;
            let renderedHeading = getRenderedHTMLHeading(
              outputWidget.node,
              onClickFactory,
              sanitizer,
              numberingDict,
              lastLevel,
              numbering,
              cell
            );
            [headings, prevHeading, collapseLevel] = Private.processMD(
              renderedHeading,
              options.showMarkdown,
              headings,
              prevHeading,
              collapseLevel,
              options.filtered,
              collapsed
            );
          }
        } else if (model.type === 'markdown') {
          let mdCell = cell as MarkdownCell;
          let renderedHeading: INotebookHeading | undefined = undefined;
          let lastLevel = getLastHeadingLevel(headings);
          // If the cell is rendered, generate the ToC items from the HTML
          if (mdCell.rendered && !mdCell.inputHidden) {
            const onClickFactory = (el: Element) => {
              return () => {
                if (!mdCell.rendered) {
                  panel.content.activeCellIndex = i;
                  el.scrollIntoView();
                } else {
                  panel.content.mode = 'command';
                  cell.node.scrollIntoView();
                  panel.content.activeCellIndex = i;
                }
              };
            };
            renderedHeading = getRenderedHTMLHeading(
              cell.node,
              onClickFactory,
              sanitizer,
              numberingDict,
              lastLevel,
              options.numbering,
              cell
            );
            // If not rendered, generate ToC items from the text of the cell
          } else {
            const onClickFactory = (line: number) => {
              return () => {
                panel.content.activeCellIndex = i;
                cell.node.scrollIntoView();
              };
            };
            renderedHeading = getMarkdownHeading(
              model!.value.text,
              onClickFactory,
              numberingDict,
              lastLevel,
              cell
            );
          }
          // Add to headings if applicable
          [headings, prevHeading, collapseLevel] = Private.processMD(
            renderedHeading,
            options.showMarkdown,
            headings,
            prevHeading,
            collapseLevel,
            options.filtered,
            collapsed
          );
        }
      }
      return headings;
    }
  };
}

namespace Private {
  export function processMD(
    renderedHeading: INotebookHeading | undefined,
    showMarkdown: boolean,
    headings: INotebookHeading[],
    prevHeading: INotebookHeading | null,
    collapseLevel: number,
    filtered: string[],
    collapsed: boolean
  ): [INotebookHeading[], INotebookHeading | null, number] {
    // If the heading is MD and MD is shown, add to headings
    if (
      renderedHeading &&
      renderedHeading.type === 'markdown' &&
      showMarkdown
    ) {
      [headings, prevHeading] = Private.addMDOrCode(
        headings,
        renderedHeading,
        prevHeading,
        collapseLevel,
        filtered
      );
      // Otherwise, if the heading is a header, add to headings
    } else if (renderedHeading && renderedHeading.type === 'header') {
      [headings, prevHeading, collapseLevel] = appendHeading(
        headings,
        renderedHeading,
        prevHeading,
        collapseLevel,
        filtered,
        collapsed
      );
    }
    return [headings, prevHeading, collapseLevel];
  }

  export function addMDOrCode(
    headings: INotebookHeading[],
    renderedHeading: INotebookHeading,
    prevHeading: INotebookHeading | null,
    collapseLevel: number,
    filtered: string[]
  ): [INotebookHeading[], INotebookHeading | null] {
    if (
      !isHeadingFiltered(renderedHeading, filtered) &&
      renderedHeading &&
      renderedHeading.text
    ) {
      // If there is a previous header, find it and mark hasChild true
      if (prevHeading && prevHeading.type === 'header') {
        for (let j = headings.length - 1; j >= 0; j--) {
          if (headings[j] === prevHeading) {
            headings[j].hasChild = true;
          }
        }
      }
      if (collapseLevel < 0) {
        headings.push(renderedHeading);
      }
      prevHeading = renderedHeading;
    }
    return [headings, prevHeading];
  }
}
